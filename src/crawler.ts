import { lookup } from 'node:dns/promises';
import { CircuitBreaker } from './circuitBreaker.ts';
import config, { CONCURRENCY } from './config.ts';
import dataService from './dataService.ts';
import { crawlerLogger as logger } from './logger.ts';
import type { CrawlResult, NetInfo, Peer, StatusResponse } from './types.ts';
import { isPrivateIP, isValidUrl, normalizeUrl } from './utils.ts';

const MAX_FAILURES = 10;
const MAX_DEPTH = config.crawler.maxDepth || 3;
const MIN_REQUEST_INTERVAL_MS = 100;

// Full list of known RPC ports for initial endpoint checking
// Order matters: most common first for faster discovery
const RPC_PORTS_FULL = [
	443, // HTTPS standard - many production endpoints
	26657, // Tendermint default RPC port
	80, // HTTP standard
	36657, // Common custom port
	26667, // Common variation
	26677, // Common variation
	22257, // Custom port
	14657, // Custom port
	58657, // Custom port
	33657, // Custom port
	53657, // Custom port
	37657, // Custom port
	31657, // Custom port
	10157, // Custom port
	27957, // Custom port
	2401, // Custom port
	15957, // Custom port
	8080, // HTTP alternate
	8000, // HTTP alternate
];

// Minimal ports for peer scanning - most peers only expose RPC on standard ports
// This dramatically reduces scan time since most peer IPs don't have RPC at all
const PEER_SCAN_PORTS = [
	443, // HTTPS - most common for production nodes
	26657, // Tendermint default - most common for validators
	80, // HTTP standard
	36657, // Second most common variation
];

// Validate that a port is likely to be an RPC port
function isValidRpcPort(port: number): boolean {
	// Filter out obviously wrong ports
	if (port < 80 || port > 65535) return false;
	// Skip well-known non-RPC ports
	const invalidPorts = [21, 22, 23, 25, 53, 110, 143, 993, 995]; // FTP, SSH, Telnet, SMTP, DNS, etc.
	if (invalidPorts.includes(port)) return false;
	return true;
}

// Get ports for peer scanning - use minimal list for speed
function getPeerScanPorts(): number[] {
	return PEER_SCAN_PORTS;
}

// Get full port list for initial endpoint expansion
function getFullRpcPorts(): number[] {
	return RPC_PORTS_FULL;
}

// Rate limiter: track last request time per host
const hostLastRequest = new Map<string, number>();

function canRequestHost(host: string): boolean {
	const last = hostLastRequest.get(host);
	if (!last) return true;
	return Date.now() - last >= MIN_REQUEST_INTERVAL_MS;
}

function markHostRequested(host: string): void {
	hostLastRequest.set(host, Date.now());
}

// DNS resolution cache
const dnsCache = new Map<string, { ips: string[]; expires: number }>();
const DNS_CACHE_TTL = 5 * 60 * 1000;

async function resolveDomain(domain: string): Promise<string[]> {
	if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
		return [domain];
	}

	const cached = dnsCache.get(domain);
	if (cached && cached.expires > Date.now()) {
		logger.debug(`DNS cache hit for ${domain}`, { ips: cached.ips });
		return cached.ips;
	}

	try {
		logger.debug(`Resolving DNS for ${domain}`);
		const result = await lookup(domain, { all: true });
		const ips = result.map((r) => r.address).filter((ip) => !isPrivateIP(ip));
		if (ips.length > 0) {
			dnsCache.set(domain, { ips, expires: Date.now() + DNS_CACHE_TTL });
			logger.info(`DNS resolved ${domain} -> ${ips.join(', ')}`);
		} else {
			logger.debug(`DNS resolved ${domain} but all IPs were private/filtered`);
		}
		return ips;
	} catch (err) {
		logger.debug(`DNS resolution failed for ${domain}`, err);
		return [];
	}
}

// HTTPS probe for non-standard ports
async function probeHttps(host: string, port: number): Promise<boolean> {
	const url = `https://${host}:${port}/status`;
	logger.debug(`HTTPS probe: ${url}`);
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
		const isHttps = response.ok || response.status < 500;
		logger.debug(`HTTPS probe ${url}: ${isHttps ? 'success' : 'failed'}`, {
			status: response.status,
		});
		return isHttps;
	} catch (err) {
		logger.debug(`HTTPS probe ${url}: failed`, err);
		return false;
	}
}

async function fetchWithTimeout<T>(
	url: string,
	timeoutMs = config.crawler.timeout
): Promise<{ data: T | null; raw?: string; error?: string }> {
	logger.debug(`Fetching: ${url} (timeout: ${timeoutMs}ms)`);
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
		});

		const rawText = await response.text();
		logger.debug(`Response from ${url}`, {
			status: response.status,
			contentLength: rawText.length,
			preview: rawText.substring(0, 200),
		});

		if (!response.ok) {
			return { data: null, raw: rawText, error: `HTTP ${response.status}` };
		}

		try {
			const data = JSON.parse(rawText) as T;
			return { data, raw: rawText };
		} catch {
			return { data: null, raw: rawText, error: 'Invalid JSON' };
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.debug(`Fetch failed: ${url}`, { error: errorMsg });
		return { data: null, error: errorMsg };
	}
}

async function fetchNetInfo(url: string): Promise<NetInfo | null> {
	const netInfoUrl = `${url}/net_info`;
	logger.debug(`Fetching net_info: ${netInfoUrl}`);
	const { data, error } = await fetchWithTimeout<{ result: NetInfo }>(netInfoUrl);
	if (error) {
		logger.debug(`net_info failed for ${url}`, { error });
	}
	return data?.result ?? null;
}

interface ExtractedPeer {
	host: string;
	isIp: boolean;
}

function isNonRoutable(host: string): boolean {
	if (!host) return true;
	const lower = host.toLowerCase();
	if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::1') return true;
	if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
	return false;
}

// Extract port from any address string
function extractPort(addr: string): number | null {
	if (!addr) return null;
	const portMatch = addr.match(/:(\d+)(?:\/|$)/);
	if (portMatch) {
		const port = Number.parseInt(portMatch[1], 10);
		if (port > 0 && port <= 65535) return port;
	}
	return null;
}

// Extract host from various address formats
function extractHost(addr: string): string | null {
	if (!addr) return null;
	// Remove protocol prefix
	let stripped = addr.replace(/^(tcp|http|https):\/\//, '');
	// Handle IPv6 bracket notation
	if (stripped.startsWith('[')) return null; // Skip IPv6
	// Handle port-only addresses like ':26657'
	if (stripped.startsWith(':')) return null;
	// Remove port and path
	const colonIdx = stripped.lastIndexOf(':');
	if (colonIdx > 0) stripped = stripped.substring(0, colonIdx);
	// Remove any path
	const slashIdx = stripped.indexOf('/');
	if (slashIdx > 0) stripped = stripped.substring(0, slashIdx);
	return stripped || null;
}

function extractPeerInfo(peers: Peer[]): { peers: ExtractedPeer[]; newPorts: number[] } {
	const existingPorts = dataService.loadPorts();
	const newPorts: number[] = [];
	const hosts = new Set<string>();
	const results: ExtractedPeer[] = [];

	logger.debug(`Extracting peer info from ${peers.length} peers`);

	for (const peer of peers) {
		// Extract ports from ALL address fields
		const addressFields = [
			peer.node_info?.other?.rpc_address,
			peer.node_info?.listen_addr,
			peer.remote_ip ? `${peer.remote_ip}:26657` : null, // remote_ip doesn't have port
		].filter(Boolean) as string[];

		for (const addr of addressFields) {
			const port = extractPort(addr);
			// Only save ports that look like valid RPC ports
			if (port && isValidRpcPort(port) && !existingPorts.includes(port) && !newPorts.includes(port)) {
				newPorts.push(port);
				logger.debug(`Discovered new port ${port} from ${addr}`);
			}
		}

		// Extract hosts from remote_ip (most reliable for public IP)
		const remoteIp = peer.remote_ip;
		if (remoteIp && !isNonRoutable(remoteIp) && !isPrivateIP(remoteIp)) {
			const isValidIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(remoteIp);
			if (isValidIp && !hosts.has(remoteIp)) {
				hosts.add(remoteIp);
				results.push({ host: remoteIp, isIp: true });
				logger.debug(`Extracted IP from remote_ip: ${remoteIp}`);
			}
		}

		// Extract hosts from listen_addr
		const listenHost = extractHost(peer.node_info?.listen_addr || '');
		if (
			listenHost &&
			!isNonRoutable(listenHost) &&
			!isPrivateIP(listenHost) &&
			!hosts.has(listenHost)
		) {
			hosts.add(listenHost);
			const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(listenHost);
			results.push({ host: listenHost, isIp });
			logger.debug(`Extracted host from listen_addr: ${listenHost} (isIp: ${isIp})`);
		}

		// Extract hosts from rpc_address
		const rpcHost = extractHost(peer.node_info?.other?.rpc_address || '');
		if (rpcHost && !isNonRoutable(rpcHost) && !isPrivateIP(rpcHost) && !hosts.has(rpcHost)) {
			hosts.add(rpcHost);
			const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(rpcHost);
			results.push({ host: rpcHost, isIp });
			logger.debug(`Extracted host from rpc_address: ${rpcHost} (isIp: ${isIp})`);
		}
	}

	// Save any new ports discovered
	if (newPorts.length > 0) {
		const allPorts = [...existingPorts, ...newPorts];
		dataService.savePorts(allPorts);
		logger.info(`Discovered ${newPorts.length} new ports: ${newPorts.join(', ')}`);
	}

	logger.info(`Extracted ${results.length} unique hosts from ${peers.length} peers`);
	return { peers: results, newPorts };
}

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
		logger.debug(`Invalid URL, skipping: ${url}`);
		return { isValid: false, chainId: null, url, peers: [], depth, nodeId: null, moniker: null };
	}

	const parsed = new URL(normalized);
	const isHttps = parsed.protocol === 'https:' || parsed.port === '443';
	const statusUrl = `${isHttps ? 'https' : 'http'}://${parsed.host}/status`;

	logger.info(`[depth ${depth}] Checking endpoint: ${normalized}`);

	try {
		const { data, raw, error } = await fetchWithTimeout<StatusResponse>(statusUrl);

		if (error || !data?.result) {
			logger.debug(`Endpoint check failed: ${normalized}`, {
				error,
				rawPreview: raw?.substring(0, 100),
			});
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

		logger.info(
			`[depth ${depth}] ${normalized} - chainId: ${chainId}, moniker: ${moniker}, nodeId: ${nodeId?.substring(0, 8)}..., ` +
				`health: ${isHealthy ? 'OK' : 'STALE'} (${timeDiff.toFixed(1)}s behind)`
		);

		logger.debug(`Full status response from ${normalized}`, {
			nodeInfo: data.result.node_info,
			syncInfo: data.result.sync_info,
		});

		let peers: ExtractedPeer[] = [];
		if (isHealthy && depth < MAX_DEPTH) {
			const netInfo = await fetchNetInfo(normalized);
			if (netInfo?.peers) {
				const extracted = extractPeerInfo(netInfo.peers);
				peers = extracted.peers;
				logger.info(
					`[depth ${depth}] ${normalized} returned ${netInfo.peers.length} peers, extracted ${peers.length} valid hosts`
				);
			} else {
				logger.debug(`[depth ${depth}] ${normalized} returned no peers or net_info failed`);
			}
		}

		return { isValid: isHealthy, chainId, url: normalized, peers, depth, nodeId, moniker };
	} catch (err) {
		logger.error(`[depth ${depth}] Error checking ${normalized}`, err);
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

// Check a single host:port combination
async function checkHostPort(
	host: string,
	port: number,
	isIp: boolean,
	expectedChainId: string
): Promise<string | null> {
	// Rate limiting per host
	if (!canRequestHost(host)) {
		await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS));
	}
	markHostRequested(host);

	// Determine protocol based on port and host type
	let protocols: string[];
	if (port === 443) {
		protocols = ['https'];
	} else if (port === 80) {
		protocols = ['http'];
	} else {
		// For non-standard ports: IPs try http first, domains try https first
		protocols = isIp ? ['http', 'https'] : ['https', 'http'];
	}

	for (const protocol of protocols) {
		const url = `${protocol}://${host}:${port}/status`;
		logger.debug(`Trying: ${url}`);

		try {
			const { data, error } = await fetchWithTimeout<StatusResponse>(url);

			if (data?.result?.node_info?.network === expectedChainId) {
				const endpoint = `${protocol}://${host}:${port}`;
				logger.info(`Found valid endpoint: ${endpoint} (chainId: ${expectedChainId})`);
				return endpoint;
			}
			if (data?.result?.node_info?.network) {
				logger.debug(`${url} returned different chainId: ${data.result.node_info.network}`);
				break; // Valid response but wrong chain, don't try other protocol
			}
			if (error) {
				logger.debug(`${url} failed: ${error}`);
			}
		} catch {
			// Connection error, try next protocol
		}
	}

	return null;
}

async function checkPeerEndpoints(
	peers: ExtractedPeer[],
	expectedChainId: string
): Promise<string[]> {
	const validEndpoints: string[] = [];
	const checkedCombos = new Set<string>();
	const foundHosts = new Set<string>(); // Track hosts with valid endpoints

	logger.info(`Checking peer endpoints for ${peers.length} hosts (chainId: ${expectedChainId})`);

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
						logger.debug(`Added resolved IP ${ip} for domain ${peer.host}`);
					}
				}
			}
		}
	}

	logger.info(
		`Expanded ${peers.length} peers to ${expandedPeers.length} hosts (after DNS resolution)`
	);

	// Use minimal port list for peer scanning - most peers don't expose RPC at all
	const scanPorts = getPeerScanPorts();
	logger.info(`Scanning ${scanPorts.length} common RPC ports across ${expandedPeers.length} hosts`);

	// PORT-FIRST ITERATION: For each port, check all hosts
	// This avoids rate limiting by spreading requests across hosts
	for (const port of scanPorts) {
		// Filter to hosts we haven't found endpoints for yet
		const hostsToCheck = expandedPeers.filter((peer) => {
			if (foundHosts.has(peer.host)) return false; // Already found
			const comboKey = `${peer.host}:${port}`;
			if (checkedCombos.has(comboKey)) return false;
			checkedCombos.add(comboKey);
			return true;
		});

		if (hostsToCheck.length === 0) continue;

		logger.info(`Port ${port}: checking ${hostsToCheck.length} remaining hosts`);

		// Process hosts in batches for concurrency
		const batchSize = CONCURRENCY.CRAWLER_PEERS;
		for (let i = 0; i < hostsToCheck.length; i += batchSize) {
			const batch = hostsToCheck.slice(i, i + batchSize);

			const batchResults = await Promise.all(
				batch.map(async (peer) => {
					// Double-check in case another batch found it
					if (foundHosts.has(peer.host)) return null;

					const endpoint = await checkHostPort(peer.host, port, peer.isIp, expectedChainId);
					if (endpoint) {
						foundHosts.add(peer.host);
						// Also mark domain as found if this was a resolved IP
						for (const [domain, ips] of domainToIps) {
							if (ips.includes(peer.host)) {
								foundHosts.add(domain);
								break;
							}
						}
					}
					return endpoint;
				})
			);

			for (const endpoint of batchResults) {
				if (endpoint) {
					validEndpoints.push(endpoint);
				}
			}
		}

		// Early exit if we've found endpoints for all hosts
		if (foundHosts.size >= expandedPeers.length) {
			logger.info('Found endpoints for all hosts, stopping port scan early');
			break;
		}
	}

	logger.info(`Peer endpoint check complete: found ${validEndpoints.length} valid endpoints`);
	return validEndpoints;
}

export async function crawlNetwork(
	chainName: string,
	initialRpcUrls: string[]
): Promise<CrawlResult> {
	logger.info(`=== Starting crawl for chain: ${chainName} ===`);
	logger.info(`Initial URLs: ${initialRpcUrls.length}`);
	logger.debug('Initial URLs list:', initialRpcUrls);

	const chainsData = await dataService.loadChainsData();
	const checkedUrls = new Set<string>();
	const checkedHosts = new Set<string>();
	const seenNodeIds = new Set<string>();
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

	logger.info(`Expected chainId: ${expectedChainId}`);

	const startTime = Date.now();
	const timeLimit = 5 * 60 * 1000;

	const queue: QueuedEndpoint[] = initialRpcUrls
		.map((url) => normalizeUrl(url))
		.filter((url): url is string => url !== null && isValidUrl(url))
		.map((url) => ({ url, depth: 0 }));

	logger.info(`Queue initialized with ${queue.length} valid URLs (max depth: ${MAX_DEPTH})`);

	const circuitBreakers = new Map<string, CircuitBreaker>();

	try {
		let iteration = 0;
		while (queue.length > 0 && Date.now() - startTime < timeLimit) {
			iteration++;
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			logger.info(`--- Iteration ${iteration} | Queue: ${queue.length} | Elapsed: ${elapsed}s ---`);

			const batch: QueuedEndpoint[] = [];
			while (batch.length < 50 && queue.length > 0) {
				const item = queue.shift()!;
				if (!checkedUrls.has(item.url)) {
					batch.push(item);
				}
			}

			if (batch.length === 0) {
				logger.debug('No new URLs in batch, continuing...');
				continue;
			}

			logger.info(`Processing batch of ${batch.length} URLs`);

			const results = await Promise.all(
				batch.map(async ({ url, depth }) => {
					if (!circuitBreakers.has(url)) {
						circuitBreakers.set(url, new CircuitBreaker());
					}
					const cb = circuitBreakers.get(url)!;
					if (cb.isOpen()) {
						logger.debug(`Circuit breaker open for ${url}, skipping`);
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

			// Collect all unique peers from this batch for a single combined scan
			const batchPeers: ExtractedPeer[] = [];
			let maxDepthInBatch = 0;

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

					if (result.nodeId && seenNodeIds.has(result.nodeId)) {
						skippedDuplicateNodes++;
						logger.debug(
							`[depth ${result.depth}] Duplicate node ${result.nodeId} (${result.moniker}) at ${result.url}`
						);
						continue;
					}

					if (result.nodeId) {
						seenNodeIds.add(result.nodeId);
					}

					if (result.chainId === expectedChainId) {
						if (!chainsData[chainName].rpcAddresses.includes(result.url)) {
							chainsData[chainName].rpcAddresses.push(result.url);
							newEndpoints++;
							logger.info(
								`[depth ${result.depth}] NEW ENDPOINT: ${result.url} (${result.moniker || 'unknown'})`
							);
						} else {
							logger.debug(`[depth ${result.depth}] Known endpoint: ${result.url}`);
						}
						goodIPs[new URL(result.url).hostname] = Date.now();

						// Collect peers for batch scan instead of immediate scan
						if (result.depth < MAX_DEPTH && result.peers.length > 0) {
							const newPeers = result.peers.filter(
								(peer) => !checkedHosts.has(peer.host) && !rejectedIPs.has(peer.host)
							);
							for (const peer of newPeers) {
								if (!batchPeers.some((p) => p.host === peer.host)) {
									batchPeers.push(peer);
								}
							}
							if (result.depth > maxDepthInBatch) maxDepthInBatch = result.depth;
						}
					} else if (result.chainId && chainsData[result.chainId]) {
						if (!chainsData[result.chainId].rpcAddresses.includes(result.url)) {
							chainsData[result.chainId].rpcAddresses.push(result.url);
							misplacedEndpoints++;
							logger.info(
								`[depth ${result.depth}] MISPLACED ENDPOINT: ${result.url} -> ${result.chainId}`
							);
						}
					} else if (result.chainId) {
						logger.debug(
							`[depth ${result.depth}] Unknown chainId ${result.chainId} at ${result.url}`
						);
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
								logger.info(`Host ${hostname} permanently rejected after ${MAX_FAILURES} failures`);
							}
						} else {
							blacklistedIPs.push({ ip: hostname, failureCount: 1, timestamp: Date.now() });
						}
					} catch {
						// Ignore invalid URLs
					}
				}
			}

			// Batch peer scan: process all collected peers at once
			if (batchPeers.length > 0) {
				const peersToScan = batchPeers.slice(0, 50);
				logger.info(
					`Batch peer scan: ${peersToScan.length} unique hosts (${batchPeers.length} total collected)`
				);
				const validEndpoints = await checkPeerEndpoints(peersToScan, expectedChainId);
				for (const endpoint of validEndpoints) {
					if (!checkedUrls.has(endpoint)) {
						queue.push({ url: endpoint, depth: maxDepthInBatch + 1 });
					}
				}
				logger.info(`Batch peer scan complete: queued ${validEndpoints.length} new endpoints`);
			}

			// Periodic save
			if (newEndpoints > 0 && newEndpoints % 10 === 0) {
				logger.info(`Periodic save: ${newEndpoints} new endpoints so far`);
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
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

	logger.info(`=== Crawl complete for ${chainName} ===`);
	logger.info(`Duration: ${elapsed}s`);
	logger.info(`New endpoints: ${newEndpoints}`);
	logger.info(`Total endpoints: ${totalEndpoints}`);
	logger.info(`Misplaced endpoints: ${misplacedEndpoints}`);
	logger.info(`URLs checked: ${checkedUrls.size}`);
	logger.info(`Duplicate nodes skipped: ${skippedDuplicateNodes}`);

	return {
		newEndpoints,
		totalEndpoints,
		misplacedEndpoints,
	};
}

export async function crawlAllChains(): Promise<Record<string, CrawlResult>> {
	logger.info('=== Starting crawl for ALL chains ===');

	const chainsData = await dataService.loadChainsData();
	const results: Record<string, CrawlResult> = {};

	const chainNames = Object.keys(chainsData);
	logger.info(`Total chains to crawl: ${chainNames.length}`);

	const batchSize = CONCURRENCY.CHAIN_CRAWLING;

	for (let i = 0; i < chainNames.length; i += batchSize) {
		const batch = chainNames.slice(i, i + batchSize);
		const batchNum = Math.floor(i / batchSize) + 1;
		const totalBatches = Math.ceil(chainNames.length / batchSize);

		logger.info(`--- Chain batch ${batchNum}/${totalBatches}: ${batch.join(', ')} ---`);

		const batchResults = await Promise.all(
			batch.map(async (chainName) => {
				logger.info(`Starting crawl for chain: ${chainName}`);
				try {
					const chainData = chainsData[chainName];
					if (!chainData?.rpcAddresses?.length) {
						logger.error(`Invalid chain data for ${chainName}: no RPC addresses`);
						return { chainName, result: null };
					}

					logger.info(`${chainName}: ${chainData.rpcAddresses.length} initial RPC addresses`);
					const result = await crawlNetwork(chainName, chainData.rpcAddresses);
					logger.info(
						`Finished crawling: ${chainName} (new: ${result.newEndpoints}, total: ${result.totalEndpoints})`
					);
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

	const totalNew = Object.values(results).reduce((sum, r) => sum + r.newEndpoints, 0);
	const totalEndpoints = Object.values(results).reduce((sum, r) => sum + r.totalEndpoints, 0);

	logger.info('=== All chains crawl complete ===');
	logger.info(`Chains processed: ${Object.keys(results).length}`);
	logger.info(`Total new endpoints: ${totalNew}`);
	logger.info(`Total endpoints across all chains: ${totalEndpoints}`);

	return results;
}
