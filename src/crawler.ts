import { lookup } from 'node:dns/promises';
import { CircuitBreaker } from './circuitBreaker.ts';
import config, { CONCURRENCY } from './config.ts';
import dataService from './dataService.ts';
import { crawlerLogger as logger } from './logger.ts';
// Network crawler using Bun's native fetch
import type { CrawlResult, NetInfo, Peer, StatusResponse } from './types.ts';
import { isPrivateIP, isValidUrl, normalizeUrl } from './utils.ts';

const MAX_FAILURES = 10;
const MAX_DEPTH = config.crawler.maxDepth || 3;
const MIN_REQUEST_INTERVAL_MS = 200; // Min ms between requests to same host

// Rate limiter: track last request time per host (IP or domain)
const hostLastRequest = new Map<string, number>();

function canRequestHost(host: string): boolean {
	const last = hostLastRequest.get(host);
	if (!last) return true;
	return Date.now() - last >= MIN_REQUEST_INTERVAL_MS;
}

function markHostRequested(host: string): void {
	hostLastRequest.set(host, Date.now());
}

// DNS resolution cache (domain -> IPs)
const dnsCache = new Map<string, { ips: string[]; expires: number }>();
const DNS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function resolveDomain(domain: string): Promise<string[]> {
	// Skip if already an IP
	if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
		return [domain];
	}

	// Check cache
	const cached = dnsCache.get(domain);
	if (cached && cached.expires > Date.now()) {
		return cached.ips;
	}

	try {
		const result = await lookup(domain, { all: true });
		const ips = result.map((r) => r.address).filter((ip) => !isPrivateIP(ip));
		if (ips.length > 0) {
			dnsCache.set(domain, { ips, expires: Date.now() + DNS_CACHE_TTL });
			logger.debug(`Resolved ${domain} to ${ips.join(', ')}`);
		}
		return ips;
	} catch {
		return [];
	}
}

async function fetchWithTimeout<T>(
	url: string,
	timeoutMs = config.crawler.timeout
): Promise<T | null> {
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return null;
		return response.json() as Promise<T>;
	} catch {
		return null;
	}
}

async function fetchNetInfo(url: string): Promise<NetInfo | null> {
	const data = await fetchWithTimeout<{ result: NetInfo }>(`${url}/net_info`);
	return data?.result ?? null;
}

interface ExtractedPeer {
	host: string; // IP or domain
	isIp: boolean;
}

// Check if a host is non-routable (localhost, loopback, etc.)
function isNonRoutable(host: string): boolean {
	if (!host) return true;
	const lower = host.toLowerCase();
	if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1') return true;
	// Check for 127.x.x.x loopback
	if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
	return false;
}

function extractPeerInfo(peers: Peer[]): ExtractedPeer[] {
	const ports = dataService.loadPorts();
	const newPorts: number[] = [];
	const hosts = new Set<string>();
	const results: ExtractedPeer[] = [];

	for (const peer of peers) {
		// Extract port from rpc_address even if the address itself is not routable
		const rpcAddr = peer.node_info?.other?.rpc_address;
		if (rpcAddr) {
			const portMatch = rpcAddr.match(/:(\d+)$/);
			if (portMatch) {
				const port = Number.parseInt(portMatch[1], 10);
				if (
					port &&
					port > 0 &&
					port <= 65535 &&
					!ports.includes(port) &&
					!newPorts.includes(port)
				) {
					newPorts.push(port);
				}
			}
		}

		// Try to get a routable host from remote_ip first
		const remoteIp = peer.remote_ip;
		if (remoteIp && !isNonRoutable(remoteIp) && !isPrivateIP(remoteIp)) {
			// Validate IPv4 format (skip IPv6 for now)
			const isValidIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(remoteIp);
			if (isValidIp && !hosts.has(remoteIp)) {
				hosts.add(remoteIp);
				results.push({ host: remoteIp, isIp: true });
			}
		}

		// Also try to extract domain from listen_addr (tcp://domain:port or tcp://[ipv6]:port)
		const listenAddr = peer.node_info?.listen_addr;
		if (listenAddr) {
			const stripped = listenAddr.replace(/^tcp:\/\//, '');
			// Handle IPv6 bracket notation
			if (stripped.startsWith('[')) {
				// IPv6 - skip for now
				continue;
			}
			const colonIdx = stripped.lastIndexOf(':');
			const hostPart = colonIdx > 0 ? stripped.substring(0, colonIdx) : stripped;

			// Skip private IPs and non-routable addresses
			if (hostPart && !isNonRoutable(hostPart) && !isPrivateIP(hostPart)) {
				if (!hosts.has(hostPart)) {
					hosts.add(hostPart);
					const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostPart);
					results.push({ host: hostPart, isIp });
				}
			}
		}
	}

	// Save any new ports discovered from rpc_address fields
	if (newPorts.length > 0) {
		ports.push(...newPorts);
		dataService.savePorts(ports);
		logger.debug(`Added ${newPorts.length} new ports to common ports list: ${newPorts.join(', ')}`);
	}

	return results;
}

// Export test-only helper to make unit testing easier without changing runtime behavior
export const _test_extractPeerInfo = extractPeerInfo;

interface EndpointCheckResult {
	isValid: boolean;
	chainId: string | null;
	url: string;
	peers: ExtractedPeer[];
	depth: number;
	nodeId: string | null;
	moniker: string | null;
}

interface QueuedEndpoint {
	url: string;
	depth: number;
}

async function checkEndpointWithDepth(
	url: string,
	_expectedChainId: string,
	depth: number
): Promise<EndpointCheckResult> {
	const normalized = normalizeUrl(url);
	if (!normalized) {
		return { isValid: false, chainId: null, url, peers: [], depth, nodeId: null, moniker: null };
	}

	const parsed = new URL(normalized);
	const isHttps = parsed.protocol === 'https:' || parsed.port === '443';
	const statusUrl = `${isHttps ? 'https' : 'http'}://${parsed.host}/status`;

	try {
		logger.debug(`Checking endpoint (depth ${depth}): ${normalized}`);

		const data = await fetchWithTimeout<StatusResponse>(statusUrl);
		if (!data?.result) {
			return {
				isValid: false,
				chainId: null,
				url: normalized,
				peers: [],
				depth,
				nodeId: null,
				moniker: null,
			};
		}

		const chainId = data.result.node_info?.network;
		const nodeId = data.result.node_info?.id || null;
		const moniker = data.result.node_info?.moniker || null;
		const latestBlockTime = new Date(data.result.sync_info?.latest_block_time);
		const timeDiff = Math.abs(Date.now() - latestBlockTime.getTime()) / 1000;
		const isHealthy = timeDiff <= 60;

		logger.debug(
			`${normalized} nodeId: ${nodeId}, moniker: ${moniker}, chainId: ${chainId}, health: ${isHealthy ? 'ok' : 'stale'} (${timeDiff}s behind)`
		);

		let peers: ExtractedPeer[] = [];
		// Only fetch peers if we haven't reached max depth
		if (isHealthy && depth < MAX_DEPTH) {
			const netInfo = await fetchNetInfo(normalized);
			if (netInfo?.peers) {
				peers = extractPeerInfo(netInfo.peers);
				logger.debug(
					`${normalized} returned ${peers.length} peers (will descend to depth ${depth + 1})`
				);
			}
		}

		return { isValid: isHealthy, chainId, url: normalized, peers, depth, nodeId, moniker };
	} catch (err) {
		logger.error(`Error checking ${normalized}`, err);
		return {
			isValid: false,
			chainId: null,
			url: normalized,
			peers: [],
			depth,
			nodeId: null,
			moniker: null,
		};
	}
}

async function checkPeerEndpoints(
	peers: ExtractedPeer[],
	expectedChainId: string
): Promise<string[]> {
	const validEndpoints: string[] = [];
	const foundHosts = new Set<string>(); // Track which hosts we've found valid endpoints for
	const checkedCombos = new Set<string>(); // Track host:port combos we've tried

	// Focus on high-priority RPC ports only for peer discovery (faster scanning)
	// Full port list is used during main crawl, not peer expansion
	const priorityPorts = [443, 26657, 80, 36657, 46657, 26667, 26677];
	const allPorts = priorityPorts;

	// Expand peers with resolved IPs for domains
	const expandedPeers: ExtractedPeer[] = [];
	const domainToIps = new Map<string, string[]>();

	for (const peer of peers) {
		expandedPeers.push(peer);
		if (!peer.isIp) {
			const ips = await resolveDomain(peer.host);
			if (ips.length > 0) {
				domainToIps.set(peer.host, ips);
				for (const ip of ips) {
					if (!expandedPeers.some((p) => p.host === ip)) {
						expandedPeers.push({ host: ip, isIp: true });
					}
				}
			}
		}
	}

	const checkEndpoint = async (
		host: string,
		protocol: string,
		port: number,
		originalDomain?: string
	): Promise<boolean> => {
		// Skip if we already found an endpoint for this host or its domain
		if (foundHosts.has(host)) return true;
		if (originalDomain && foundHosts.has(originalDomain)) return true;

		const comboKey = `${host}:${port}`;
		if (checkedCombos.has(comboKey)) return false;
		checkedCombos.add(comboKey);

		// Rate limiting: wait if we recently hit this host
		if (!canRequestHost(host)) {
			await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS));
		}
		markHostRequested(host);

		const url = `${protocol}://${host}:${port}/status`;
		try {
			const data = await fetchWithTimeout<StatusResponse>(url);
			if (data?.result?.node_info?.network === expectedChainId) {
				const endpoint = url.replace('/status', '');
				validEndpoints.push(endpoint);
				foundHosts.add(host);
				if (originalDomain) foundHosts.add(originalDomain);
				logger.debug(`Found valid endpoint: ${endpoint}`);
				return true;
			}
		} catch {
			// Ignore connection errors
		}
		return false;
	};

	// Port-first iteration: cycle through peers for each port to avoid rate limiting
	for (const port of allPorts) {
		const remainingPeers = expandedPeers.filter((p) => !foundHosts.has(p.host));
		if (remainingPeers.length === 0) break;

		// Process in batches for concurrency
		const batchSize = CONCURRENCY.CRAWLER_PEERS;
		for (let i = 0; i < remainingPeers.length; i += batchSize) {
			const batch = remainingPeers.slice(i, i + batchSize);

			await Promise.all(
				batch.map(async (peer) => {
					if (foundHosts.has(peer.host)) return;

					// Find original domain if this is a resolved IP
					let originalDomain: string | undefined;
					for (const [domain, ips] of domainToIps) {
						if (ips.includes(peer.host)) {
							originalDomain = domain;
							break;
						}
					}

					if (port === 443) {
						// Only try https for port 443
						await checkEndpoint(peer.host, 'https', 443, originalDomain);
					} else {
						// For IPs, try http first; for domains, try https first
						if (peer.isIp) {
							if (!(await checkEndpoint(peer.host, 'http', port, originalDomain))) {
								await checkEndpoint(peer.host, 'https', port, originalDomain);
							}
						} else {
							if (!(await checkEndpoint(peer.host, 'https', port, originalDomain))) {
								await checkEndpoint(peer.host, 'http', port, originalDomain);
							}
						}
					}
				})
			);
		}
	}

	return validEndpoints;
}

export async function crawlNetwork(
	chainName: string,
	initialRpcUrls: string[]
): Promise<CrawlResult> {
	const chainsData = await dataService.loadChainsData();
	const checkedUrls = new Set<string>();
	const checkedHosts = new Set<string>(); // Track hosts to avoid redundant port scanning
	const seenNodeIds = new Set<string>(); // Track node IDs to avoid crawling same node via different URLs
	const rejectedIPs = new Set(dataService.loadRejectedIPs());
	const goodIPs: Record<string, number> = dataService.loadGoodIPs();
	const blacklistedIPs = await dataService.loadBlacklistedIPs();

	let newEndpoints = 0;
	let misplacedEndpoints = 0;
	let skippedDuplicateNodes = 0;

	const expectedChainId = chainsData[chainName]?.chainId;
	if (!expectedChainId) {
		logger.error(`Chain ${chainName} not found in chains data`);
		return { newEndpoints: 0, totalEndpoints: 0, misplacedEndpoints: 0 };
	}

	const startTime = Date.now();
	const timeLimit = 5 * 60 * 1000; // 5 minutes

	logger.info(
		`Starting recursive crawl for ${chainName} with ${initialRpcUrls.length} initial URLs (max depth: ${MAX_DEPTH})`
	);

	// Queue with depth tracking - use array as FIFO queue
	const queue: QueuedEndpoint[] = initialRpcUrls
		.map((url) => normalizeUrl(url))
		.filter((url): url is string => url !== null && isValidUrl(url))
		.map((url) => ({ url, depth: 0 }));

	const circuitBreakers = new Map<string, CircuitBreaker>();

	try {
		while (queue.length > 0 && Date.now() - startTime < timeLimit) {
			// Take batch from queue, filtering already checked
			const batch: QueuedEndpoint[] = [];
			while (batch.length < 50 && queue.length > 0) {
				const item = queue.shift()!;
				if (!checkedUrls.has(item.url)) {
					batch.push(item);
				}
			}

			if (batch.length === 0) continue;

			const results = await Promise.all(
				batch.map(async ({ url, depth }) => {
					if (!circuitBreakers.has(url)) {
						circuitBreakers.set(url, new CircuitBreaker());
					}
					const cb = circuitBreakers.get(url)!;
					if (cb.isOpen()) {
						return {
							isValid: false,
							chainId: null,
							url,
							peers: [],
							depth,
							nodeId: null,
							moniker: null,
						};
					}
					return checkEndpointWithDepth(url, expectedChainId, depth);
				})
			);

			for (const result of results) {
				checkedUrls.add(result.url);
				try {
					checkedHosts.add(new URL(result.url).hostname);
				} catch {
					// Ignore invalid URLs
				}
				const cb = circuitBreakers.get(result.url)!;

				if (result.isValid) {
					cb.recordSuccess();

					// Skip if we've already seen this node (by nodeId)
					if (result.nodeId && seenNodeIds.has(result.nodeId)) {
						skippedDuplicateNodes++;
						logger.debug(
							`[depth ${result.depth}] Skipping duplicate node ${result.nodeId} (${result.moniker}) at ${result.url}`
						);
						continue;
					}

					// Mark this node as seen
					if (result.nodeId) {
						seenNodeIds.add(result.nodeId);
					}

					if (result.chainId === expectedChainId) {
						if (!chainsData[chainName].rpcAddresses.includes(result.url)) {
							chainsData[chainName].rpcAddresses.push(result.url);
							newEndpoints++;
							logger.info(
								`[depth ${result.depth}] Added RPC for ${chainName}: ${result.url} (${result.moniker || 'unknown'})`
							);
						}
						goodIPs[new URL(result.url).hostname] = Date.now();

						// Add discovered peers to queue at next depth level
						if (result.depth < MAX_DEPTH && result.peers.length > 0) {
							const newPeers = result.peers.filter(
								(peer) => !checkedHosts.has(peer.host) && !rejectedIPs.has(peer.host)
							);

							if (newPeers.length > 0) {
								logger.debug(
									`[depth ${result.depth}] Queueing ${newPeers.length} new peers for descent`
								);

								// Validate peers before queueing (port-first iteration to avoid rate limiting)
								const validEndpoints = await checkPeerEndpoints(newPeers, expectedChainId);
								for (const endpoint of validEndpoints) {
									if (!checkedUrls.has(endpoint)) {
										queue.push({ url: endpoint, depth: result.depth + 1 });
									}
								}
							}
						}
					} else if (result.chainId && chainsData[result.chainId]) {
						if (!chainsData[result.chainId].rpcAddresses.includes(result.url)) {
							chainsData[result.chainId].rpcAddresses.push(result.url);
							misplacedEndpoints++;
							logger.info(
								`[depth ${result.depth}] Added misplaced RPC: ${result.url} to ${result.chainId}`
							);
						}
					}
				} else {
					cb.recordFailure();
					try {
						const hostname = new URL(result.url).hostname;
						const entry = blacklistedIPs.find((item) => item.ip === hostname);
						if (entry) {
							entry.failureCount = (entry.failureCount || 0) + 1;
							entry.timestamp = Date.now();
							if (entry.failureCount >= MAX_FAILURES) {
								rejectedIPs.add(hostname);
							}
						} else {
							blacklistedIPs.push({ ip: hostname, failureCount: 1, timestamp: Date.now() });
						}
					} catch {
						// Ignore invalid URLs
					}
				}
			}

			// Periodic save
			if (newEndpoints % 10 === 0 && newEndpoints > 0) {
				await dataService.saveChainsData(chainsData);
				dataService.saveGoodIPs(goodIPs);
				dataService.saveRejectedIPs([...rejectedIPs]);
				await dataService.saveBlacklistedIPs(blacklistedIPs);
			}
		}
	} catch (err) {
		logger.error(`Unexpected error during crawl for ${chainName}`, err);
	} finally {
		await dataService.saveChainsData(chainsData);
		dataService.saveGoodIPs(goodIPs);
		dataService.saveRejectedIPs([...rejectedIPs]);
		await dataService.saveBlacklistedIPs(blacklistedIPs);
	}

	const totalEndpoints = chainsData[chainName].rpcAddresses.length;
	logger.info(
		`Crawl for ${chainName} finished. New: ${newEndpoints}, Total: ${totalEndpoints}, Checked: ${checkedUrls.size} URLs, Skipped duplicates: ${skippedDuplicateNodes}`
	);

	return {
		newEndpoints,
		totalEndpoints,
		misplacedEndpoints,
	};
}

export async function crawlAllChains(): Promise<Record<string, CrawlResult>> {
	const chainsData = await dataService.loadChainsData();
	const results: Record<string, CrawlResult> = {};

	const chainNames = Object.keys(chainsData);
	const batchSize = CONCURRENCY.CHAIN_CRAWLING;

	for (let i = 0; i < chainNames.length; i += batchSize) {
		const batch = chainNames.slice(i, i + batchSize);

		const batchResults = await Promise.all(
			batch.map(async (chainName) => {
				logger.info(`Crawling chain: ${chainName}`);
				try {
					const chainData = chainsData[chainName];
					if (!chainData?.rpcAddresses?.length) {
						logger.error(`Invalid chain data for ${chainName}`);
						return { chainName, result: null };
					}

					const result = await crawlNetwork(chainName, chainData.rpcAddresses);
					logger.info(`Finished crawling: ${chainName}`);
					return { chainName, result };
				} catch (err) {
					logger.error(`Error crawling ${chainName}`, err);
					return { chainName, result: null };
				}
			})
		);

		for (const { chainName, result } of batchResults) {
			if (result) {
				results[chainName] = result;
			}
		}
	}

	logger.info('Finished crawling all chains');
	return results;
}
