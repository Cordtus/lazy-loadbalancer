import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { CircuitBreaker } from './circuitBreaker.ts';
import config, { CONCURRENCY } from './config.ts';
import { crawlerLogger as logger } from './logger.ts';
import { PEX_ENABLED, PEX_TIMEOUT_SEC, discoverPexPeers } from './pexDiscovery.ts';
import type { CrawlResult, NetInfo, Peer, StatusResponse } from './types.ts';
import {
	isPrivateIP,
	isValidUrl,
	loadBlacklistedIPs,
	loadChainsData,
	loadGoodIPs,
	loadPorts,
	loadRejectedIPs,
	normalizeUrl,
	saveBlacklistedIPs,
	saveChainsData,
	saveGoodIPs,
	savePorts,
	saveRejectedIPs,
} from './utils.ts';

const MAX_FAILURES = 10;
const MAX_DEPTH = config.crawler.maxDepth || 3;
const MIN_REQUEST_INTERVAL_MS = 100;
// Cheap TCP pre-check so closed/blackholed ports don't burn a full HTTP timeout.
const TCP_PROBE_TIMEOUT_MS = 2000;

// Minimal ports for peer scanning - most peers only expose RPC on standard ports
// This dramatically reduces scan time since most peer IPs don't have RPC at all
const PEER_SCAN_PORTS = [
	443, // HTTPS - most common for production nodes
	26657, // Tendermint default - most common for validators
	80, // HTTP standard
	36657, // Second most common variation
];

const REST_NODE_INFO_PATH = '/cosmos/base/tendermint/v1beta1/node_info';
const REST_SCAN_PORTS = [
	443, // HTTPS standard - most public REST gateways
	1317, // Cosmos SDK default REST/gRPC-gateway port
	80, // HTTP standard
	8080, // Common alternate HTTP port
	8443, // Common alternate HTTPS port
	3000, // Common proxy/app port
];

// Hosts are dropped from the expanded sweep after this many consecutive dark
// (timeout) ports. Connection-refused does not count - only silence does.
const DARK_THRESHOLD = config.crawler.darkThreshold || 3;
// A host is worth an expensive expanded sweep only if it looks like a live node.
const LIVENESS_PORTS = [26656, 26657, 443];

// Generated non-standard RPC ports: single-digit variations, permutations and
// reversals of the standard 26657 (e.g. 26607, 36657, 25667, 75662). Sorted by
// closeness to the standard port so the likely candidates are probed first.
export function buildExpandedPorts(base = 26657): number[] {
	const digits = String(base);
	const out = new Set<number>();
	for (let i = 0; i < digits.length; i++) {
		for (let d = 0; d < 10; d++) {
			out.add(Number(digits.slice(0, i) + d + digits.slice(i + 1)));
		}
	}
	const permute = (chars: string[]): string[] =>
		chars.length <= 1
			? [chars.join('')]
			: chars.flatMap((c, i) =>
					permute([...chars.slice(0, i), ...chars.slice(i + 1)]).map((p) => c + p)
				);
	for (const p of new Set(permute(digits.split('')))) out.add(Number(p));
	out.add(Number([...digits].reverse().join('')));

	const score = (p: number): number => {
		const s = String(p);
		if (s.startsWith('266')) return 0;
		if (s.startsWith('26')) return 1;
		if (s.endsWith('57') || s.endsWith('56')) return 2;
		return 3;
	};
	return [...out]
		.filter((p) => p >= 80 && p <= 65535 && p !== base)
		.sort((a, b) => score(a) - score(b) || a - b);
}

const EXPANDED_RPC_PORTS = buildExpandedPorts(26657).slice(
	0,
	Math.max(0, config.crawler.expandedPorts || 0)
);

function isIpv4Host(host: string): boolean {
	return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

interface ProbeResult {
	endpoint: string | null;
	// True only when the port was silent (timeout), not actively refused.
	dark: boolean;
}

export function parseRestNodeInfoChainId(response: unknown): string | null {
	if (!response || typeof response !== 'object') return null;
	const data = response as {
		default_node_info?: { network?: unknown };
		node_info?: { network?: unknown };
	};
	const network = data.default_node_info?.network ?? data.node_info?.network;
	return typeof network === 'string' && network.length > 0 ? network : null;
}

// RPC and REST are frequently sibling subdomains (rpc.x -> api.x / rest.x /
// lcd.x), so derive those variants when probing for REST on an RPC host.
function restHostVariants(host: string): string[] {
	const variants = [host];
	for (const to of ['api', 'rest', 'lcd']) {
		if (host.startsWith('rpc.')) variants.push(`${to}.${host.slice(4)}`);
		if (host.startsWith('rpc-')) variants.push(`${to}-${host.slice(4)}`);
	}
	return [...new Set(variants)];
}

export function buildRestEndpointCandidates(
	host: string,
	ports = REST_SCAN_PORTS,
	isIp = isIpv4Host(host)
): string[] {
	let hostOnly = host
		.trim()
		.replace(/^https?:\/\//, '')
		.split('/')[0];
	if (!hostOnly || hostOnly.startsWith('[')) return [];
	hostOnly = hostOnly.replace(/:\d+$/, '');

	const candidates: string[] = [];
	for (const port of ports) {
		const protocols =
			port === 443
				? ['https']
				: port === 80
					? ['http']
					: isIp
						? ['http', 'https']
						: ['https', 'http'];

		for (const protocol of protocols) {
			const omitPort =
				(protocol === 'https' && port === 443) || (protocol === 'http' && port === 80);
			for (const hostVariant of restHostVariants(hostOnly)) {
				const candidate = `${protocol}://${hostVariant}${omitPort ? '' : `:${port}`}`;
				if (!candidates.includes(candidate)) {
					candidates.push(candidate);
				}
			}
		}
	}

	return candidates;
}

// Validate that a port is likely to be an RPC port
function isValidRpcPort(port: number): boolean {
	// Filter out obviously wrong ports
	if (port < 80 || port > 65535) return false;
	// Skip well-known non-RPC ports
	const invalidPorts = [21, 22, 23, 25, 53, 110, 143, 993, 995]; // FTP, SSH, Telnet, SMTP, DNS, etc.
	if (invalidPorts.includes(port)) return false;
	return true;
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

async function fetchWithTimeout<T>(
	url: string,
	timeoutMs = config.crawler.timeout,
	retries = config.crawler.retries
): Promise<{ data: T | null; raw?: string; error?: string }> {
	// Retry only transport failures (timeouts/resets), not HTTP error statuses.
	// Port probes pass retries=1 so an open-but-hung port cannot multiply the
	// scan cost across the generated port sweep.
	const attempts = Math.max(1, retries);
	const retryDelayMs = Math.min(config.crawler.retryDelay || 250, 1000);
	let lastError = 'unknown error';

	for (let attempt = 0; attempt < attempts; attempt++) {
		logger.debug(`Fetching: ${url} (attempt ${attempt + 1}/${attempts}, timeout: ${timeoutMs}ms)`);
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
			lastError = err instanceof Error ? err.message : String(err);
			logger.debug(`Fetch failed: ${url}`, { error: lastError, attempt: attempt + 1 });
			if (attempt < attempts - 1) {
				await new Promise((r) => setTimeout(r, retryDelayMs));
			}
		}
	}

	return { data: null, error: lastError };
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

// Distinguishes an actively refused port from a silent (firewalled) one so the
// expanded sweep can prune only the genuinely dark hosts.
function tcpProbe(host: string, port: number): Promise<'open' | 'closed' | 'dark'> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		let settled = false;
		const finish = (status: 'open' | 'closed' | 'dark'): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(status);
		};
		const timer = setTimeout(() => finish('dark'), TCP_PROBE_TIMEOUT_MS);
		socket.once('connect', () => finish('open'));
		socket.once('error', (err: Error & { code?: string }) => {
			const refused =
				err.code === 'ECONNREFUSED' ||
				err.code === 'EHOSTUNREACH' ||
				err.code === 'ENETUNREACH' ||
				err.code === 'EADDRNOTAVAIL';
			finish(refused ? 'closed' : 'dark');
		});
	});
}

function tcpReachable(host: string, port: number): Promise<boolean> {
	return tcpProbe(host, port).then((status) => status === 'open');
}

async function isHostLive(host: string): Promise<boolean> {
	for (const port of LIVENESS_PORTS) {
		if ((await tcpProbe(host, port)) === 'open') return true;
	}
	return false;
}

export const _test_tcpReachable = tcpReachable;
export const _test_tcpProbe = tcpProbe;

export async function checkRestEndpoint(
	url: string,
	expectedChainId: string
): Promise<string | null> {
	const normalized = normalizeUrl(url);
	if (!normalized) {
		logger.debug(`Invalid REST URL, skipping: ${url}`);
		return null;
	}

	const parsed = new URL(normalized);
	const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
	if (!(await tcpReachable(parsed.hostname, port))) {
		logger.debug(`REST port closed: ${parsed.hostname}:${port}`);
		return null;
	}

	const nodeInfoUrl = `${normalized}${REST_NODE_INFO_PATH}`;
	logger.debug(`Checking REST endpoint: ${nodeInfoUrl}`);

	const { data, error } = await fetchWithTimeout<unknown>(nodeInfoUrl, config.crawler.timeout, 1);
	if (error) {
		logger.debug(`REST endpoint check failed for ${normalized}`, { error });
		return null;
	}

	const chainId = parseRestNodeInfoChainId(data);
	if (chainId === expectedChainId) {
		logger.info(`Found valid REST endpoint: ${normalized} (chainId: ${expectedChainId})`);
		return normalized;
	}

	if (chainId) {
		logger.debug(`${nodeInfoUrl} returned different chainId: ${chainId}`);
	}

	return null;
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

function extractPeerInfo(peers: Peer[]): {
	peers: ExtractedPeer[];
	newPorts: number[];
	pexSeeds: string[];
} {
	const existingPorts = loadPorts();
	const newPorts: number[] = [];
	const hosts = new Set<string>();
	const results: ExtractedPeer[] = [];
	const pexSeeds: string[] = [];

	logger.debug(`Extracting peer info from ${peers.length} peers`);

	for (const peer of peers) {
		// P2P seed for the PEX crawler: nodeID@host:p2pPort
		const nodeId = peer.node_info?.id;
		const listenAddr = peer.node_info?.listen_addr || '';
		const p2pPort = extractPort(listenAddr);
		let p2pHost = extractHost(listenAddr);
		// Some RPC proxies report remote_ip with a port or as 0.0.0.0; extractHost normalizes both.
		if (p2pHost && isNonRoutable(p2pHost)) p2pHost = extractHost(peer.remote_ip || '');
		if (nodeId && p2pHost && p2pPort && !isNonRoutable(p2pHost) && !isPrivateIP(p2pHost)) {
			const seed = `${nodeId}@${p2pHost}:${p2pPort}`;
			if (!pexSeeds.includes(seed)) pexSeeds.push(seed);
		}

		// Extract ports from ALL address fields
		const addressFields = [
			peer.node_info?.other?.rpc_address,
			peer.node_info?.listen_addr,
			peer.remote_ip ? `${peer.remote_ip}:26657` : null, // remote_ip doesn't have port
		].filter(Boolean) as string[];

		for (const addr of addressFields) {
			const port = extractPort(addr);
			// Only save ports that look like valid RPC ports
			if (
				port &&
				isValidRpcPort(port) &&
				!existingPorts.includes(port) &&
				!newPorts.includes(port)
			) {
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
		savePorts(allPorts);
		logger.info(`Discovered ${newPorts.length} new ports: ${newPorts.join(', ')}`);
	}

	logger.info(`Extracted ${results.length} unique hosts from ${peers.length} peers`);
	return { peers: results, newPorts, pexSeeds };
}

export const _test_extractPeerInfo = extractPeerInfo;

interface EndpointCheckResult {
	isValid: boolean;
	chainId: string | null;
	url: string;
	peers: ExtractedPeer[];
	pexSeeds: string[];
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
		return {
			isValid: false,
			chainId: null,
			url,
			peers: [],
			pexSeeds: [],
			depth,
			nodeId: null,
			moniker: null,
		};
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
				pexSeeds: [],
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
		let pexSeeds: string[] = [];
		if (isHealthy && depth < MAX_DEPTH) {
			const netInfo = await fetchNetInfo(normalized);
			if (netInfo?.peers) {
				const extracted = extractPeerInfo(netInfo.peers);
				peers = extracted.peers;
				pexSeeds = extracted.pexSeeds;
				logger.info(
					`[depth ${depth}] ${normalized} returned ${netInfo.peers.length} peers, extracted ${peers.length} valid hosts`
				);
			} else {
				logger.debug(`[depth ${depth}] ${normalized} returned no peers or net_info failed`);
			}
		}

		return {
			isValid: isHealthy,
			chainId,
			url: normalized,
			peers,
			pexSeeds,
			depth,
			nodeId,
			moniker,
		};
	} catch (err) {
		logger.error(`[depth ${depth}] Error checking ${normalized}`, err);
		return {
			isValid: false,
			chainId: null,
			url: normalized,
			peers: [],
			pexSeeds: [],
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
): Promise<ProbeResult> {
	// Rate limiting per host
	if (!canRequestHost(host)) {
		await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS));
	}
	markHostRequested(host);

	const tcp = await tcpProbe(host, port);
	if (tcp !== 'open') {
		logger.debug(`TCP ${tcp}: ${host}:${port}, skipping`);
		return { endpoint: null, dark: tcp === 'dark' };
	}

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
			const { data, error } = await fetchWithTimeout<StatusResponse>(
				url,
				config.crawler.timeout,
				1
			);

			if (data?.result?.node_info?.network === expectedChainId) {
				const endpoint = `${protocol}://${host}:${port}`;
				logger.info(`Found valid endpoint: ${endpoint} (chainId: ${expectedChainId})`);
				return { endpoint, dark: false };
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

	// Port is open but not serving this chain's RPC - not "dark".
	return { endpoint: null, dark: false };
}

async function expandPeersWithIps(
	peers: ExtractedPeer[]
): Promise<{ hosts: ExtractedPeer[]; domainToIps: Map<string, string[]> }> {
	const hosts: ExtractedPeer[] = [];
	const domainToIps = new Map<string, string[]>();

	for (const peer of peers) {
		hosts.push(peer);
		if (!peer.isIp) {
			const ips = await resolveDomain(peer.host);
			if (ips.length > 0) {
				domainToIps.set(peer.host, ips);
				for (const ip of ips) {
					if (!hosts.some((p) => p.host === ip)) {
						hosts.push({ host: ip, isIp: true });
					}
				}
			}
		}
	}

	return { hosts, domainToIps };
}

// Port-first scan: probe every host on each port, in batches, stopping early once
// a host has a working endpoint. `probe` decides what an endpoint looks like.
// Optionally follows up with a generated non-standard port sweep over hosts that
// had no hit, pruning hosts that go dark so the expensive sweep stays bounded.
async function scanPeers(
	peers: ExtractedPeer[],
	expectedChainId: string,
	ports: number[],
	probe: (
		host: string,
		port: number,
		isIp: boolean,
		expectedChainId: string
	) => Promise<ProbeResult>,
	label: string,
	options: { expandedPorts?: number[]; requireLiveForExpanded?: boolean; deadline?: number } = {}
): Promise<string[]> {
	const validEndpoints: string[] = [];
	const checked = new Set<string>();
	const foundHosts = new Set<string>();
	const { hosts, domainToIps } = await expandPeersWithIps(peers);

	logger.info(`Scanning ${ports.length} ${label} ports across ${hosts.length} hosts`);

	const markFound = (host: string): void => {
		foundHosts.add(host);
		for (const [domain, ips] of domainToIps) {
			if (ips.includes(host)) {
				foundHosts.add(domain);
				break;
			}
		}
	};

	const deadlineReached = (): boolean =>
		options.deadline !== undefined && Date.now() > options.deadline;

	const sweep = async (
		portList: number[],
		candidateHosts: ExtractedPeer[],
		pruneDark: boolean
	): Promise<void> => {
		const darkCounts = new Map<string, number>();
		const pruned = new Set<string>();
		// Hosts found by *this* sweep, so the early-exit count stays relative to
		// candidateHosts (foundHosts is global across sweeps).
		const foundInSweep = new Set<string>();

		for (const port of portList) {
			if (deadlineReached()) {
				logger.debug(`${label} sweep hit the crawl deadline, stopping`);
				return;
			}
			const hostsToCheck = candidateHosts.filter((peer) => {
				if (foundHosts.has(peer.host) || pruned.has(peer.host)) return false;
				const comboKey = `${peer.host}:${port}`;
				if (checked.has(comboKey)) return false;
				checked.add(comboKey);
				return true;
			});

			if (hostsToCheck.length === 0) continue;

			const batchSize = CONCURRENCY.CRAWLER_PEERS;
			for (let i = 0; i < hostsToCheck.length; i += batchSize) {
				if (deadlineReached()) {
					logger.debug(`${label} sweep hit the crawl deadline, stopping`);
					return;
				}
				const batch = hostsToCheck.slice(i, i + batchSize);

				const batchResults = await Promise.all(
					batch.map(async (peer) => {
						if (foundHosts.has(peer.host) || pruned.has(peer.host)) return null;

						const result = await probe(peer.host, port, peer.isIp, expectedChainId);
						if (result.endpoint) {
							markFound(peer.host);
							foundInSweep.add(peer.host);
							darkCounts.delete(peer.host);
							return result.endpoint;
						}
						if (pruneDark && result.dark) {
							const count = (darkCounts.get(peer.host) ?? 0) + 1;
							darkCounts.set(peer.host, count);
							if (count >= DARK_THRESHOLD) pruned.add(peer.host);
						} else {
							darkCounts.delete(peer.host);
						}
						return null;
					})
				);

				for (const endpoint of batchResults) {
					if (endpoint && !validEndpoints.includes(endpoint)) {
						validEndpoints.push(endpoint);
					}
				}
			}

			if (foundInSweep.size + pruned.size >= candidateHosts.length) break;
		}
	};

	await sweep(ports, hosts, false);

	const expanded = options.expandedPorts ?? [];
	if (expanded.length > 0 && !deadlineReached()) {
		let candidates = hosts.filter((peer) => !foundHosts.has(peer.host));
		if (options.requireLiveForExpanded && candidates.length > 0) {
			const live = new Set<string>();
			const size = CONCURRENCY.CRAWLER_PEERS;
			for (let i = 0; i < candidates.length; i += size) {
				if (deadlineReached()) break;
				await Promise.all(
					candidates.slice(i, i + size).map(async (peer) => {
						if (await isHostLive(peer.host)) live.add(peer.host);
					})
				);
			}
			candidates = candidates.filter((peer) => live.has(peer.host));
		}
		if (candidates.length > 0 && !deadlineReached()) {
			logger.info(
				`Expanded sweep: ${expanded.length} ports across ${candidates.length} live ${label} hosts`
			);
			await sweep(expanded, candidates, true);
		}
	}

	logger.info(`${label} peer endpoint check complete: found ${validEndpoints.length} endpoints`);
	return validEndpoints;
}

export const _test_scanPeers = scanPeers;

async function checkRestHostPort(
	host: string,
	port: number,
	isIp: boolean,
	expectedChainId: string
): Promise<ProbeResult> {
	for (const candidate of buildRestEndpointCandidates(host, [port], isIp)) {
		const endpoint = await checkRestEndpoint(candidate, expectedChainId);
		if (endpoint) return { endpoint, dark: false };
	}
	return { endpoint: null, dark: false };
}

// Pull the routable host out of a P2P seed (nodeID@host:port).
function parseP2pHost(seed: string): string | null {
	const at = seed.lastIndexOf('@');
	const hostPort = at >= 0 ? seed.slice(at + 1) : seed;
	const colon = hostPort.lastIndexOf(':');
	const host = colon > 0 ? hostPort.slice(0, colon) : hostPort;
	if (!host || host.startsWith('[')) return null;
	if (isNonRoutable(host) || isPrivateIP(host)) return null;
	return host;
}

export const _test_parseP2pHost = parseP2pHost;

export async function crawlNetwork(
	chainName: string,
	initialRpcUrls: string[]
): Promise<CrawlResult> {
	logger.info(`=== Starting crawl for chain: ${chainName} ===`);
	logger.info(`Initial URLs: ${initialRpcUrls.length}`);
	logger.debug('Initial URLs list:', initialRpcUrls);

	const chainsData = loadChainsData();
	const checkedUrls = new Set<string>();
	const checkedHosts = new Set<string>();
	const seenNodeIds = new Set<string>();
	const rejectedIPs = new Set(loadRejectedIPs());
	const goodIPs: Record<string, number> = loadGoodIPs();
	const blacklistedIPs = loadBlacklistedIPs();

	let newEndpoints = 0;
	let newRestEndpoints = 0;
	let misplacedEndpoints = 0;
	let skippedDuplicateNodes = 0;
	let pexRan = false;

	const expectedChainId = chainsData[chainName]?.chainId;
	if (!expectedChainId) {
		logger.error(`Chain ${chainName} not found in chains data`);
		return {
			newEndpoints: 0,
			totalEndpoints: 0,
			misplacedEndpoints: 0,
			newRestEndpoints: 0,
			totalRestEndpoints: 0,
		};
	}

	logger.info(`Expected chainId: ${expectedChainId}`);
	chainsData[chainName].restAddresses ||= [];

	const startTime = Date.now();
	const timeLimit = 5 * 60 * 1000;
	const crawlDeadline = startTime + timeLimit;

	const queue: QueuedEndpoint[] = initialRpcUrls
		.map((url) => normalizeUrl(url))
		.filter((url): url is string => url !== null && isValidUrl(url))
		.map((url) => ({ url, depth: 0 }));

	logger.info(`Queue initialized with ${queue.length} valid URLs (max depth: ${MAX_DEPTH})`);

	// Chain-registry P2P seeds give us extra PEX seeds and a set of live node
	// hosts to probe for RPC before any /net_info peer has been seen.
	const registryPexSeeds = chainsData[chainName]?.p2pSeeds ?? [];
	const registryHosts = [
		...new Map(
			registryPexSeeds
				.map(parseP2pHost)
				.filter((host): host is string => host !== null)
				.map((host) => [host, { host, isIp: isIpv4Host(host) }] as const)
		).values(),
	];

	const circuitBreakers = new Map<string, CircuitBreaker>();

	try {
		if (registryHosts.length > 0) {
			logger.info(`Seeding from ${registryHosts.length} chain-registry P2P hosts`);
			const registryRpc = await scanPeers(
				registryHosts,
				expectedChainId,
				PEER_SCAN_PORTS,
				checkHostPort,
				'registry',
				{
					expandedPorts: EXPANDED_RPC_PORTS,
					requireLiveForExpanded: true,
					deadline: crawlDeadline,
				}
			);
			for (const endpoint of registryRpc) {
				if (!checkedUrls.has(endpoint)) queue.push({ url: endpoint, depth: 0 });
			}

			const registryRest = await scanPeers(
				registryHosts,
				expectedChainId,
				REST_SCAN_PORTS,
				checkRestHostPort,
				'registry-rest',
				{ deadline: crawlDeadline }
			);
			chainsData[chainName].restAddresses ||= [];
			for (const endpoint of registryRest) {
				if (!chainsData[chainName].restAddresses?.includes(endpoint)) {
					chainsData[chainName].restAddresses?.push(endpoint);
					newRestEndpoints++;
				}
			}
			logger.info(
				`Registry seeding: ${registryRpc.length} RPC, ${registryRest.length} REST endpoints`
			);
		}

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
							pexSeeds: [],
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
			const batchRestPeers: ExtractedPeer[] = [];
			// Registry P2P seeds only need to be offered on the first iteration,
			// before the one-shot PEX pass has run.
			const batchPexSeeds = new Set<string>(pexRan ? [] : registryPexSeeds);
			let maxDepthInBatch = 0;
			const addRestPeer = (peer: ExtractedPeer): void => {
				if (!batchRestPeers.some((item) => item.host === peer.host)) {
					batchRestPeers.push(peer);
				}
			};

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
						const endpointHost = new URL(result.url).hostname;
						addRestPeer({ host: endpointHost, isIp: isIpv4Host(endpointHost) });

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
								addRestPeer(peer);
							}
							if (result.depth > maxDepthInBatch) maxDepthInBatch = result.depth;
						}

						for (const seed of result.pexSeeds) batchPexSeeds.add(seed);
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
				const validEndpoints = await scanPeers(
					peersToScan,
					expectedChainId,
					PEER_SCAN_PORTS,
					checkHostPort,
					'RPC',
					{
						expandedPorts: EXPANDED_RPC_PORTS,
						requireLiveForExpanded: true,
						deadline: crawlDeadline,
					}
				);
				for (const endpoint of validEndpoints) {
					if (!checkedUrls.has(endpoint)) {
						queue.push({ url: endpoint, depth: maxDepthInBatch + 1 });
					}
				}
				logger.info(`Batch peer scan complete: queued ${validEndpoints.length} new endpoints`);
			}

			if (batchRestPeers.length > 0) {
				const restPeersToScan = batchRestPeers.slice(0, 50);
				logger.info(
					`Batch REST scan: ${restPeersToScan.length} unique hosts (${batchRestPeers.length} total collected)`
				);
				const validRestEndpoints = await scanPeers(
					restPeersToScan,
					expectedChainId,
					REST_SCAN_PORTS,
					checkRestHostPort,
					'REST',
					{ deadline: crawlDeadline }
				);
				for (const endpoint of validRestEndpoints) {
					chainsData[chainName].restAddresses ||= [];
					if (!chainsData[chainName].restAddresses.includes(endpoint)) {
						chainsData[chainName].restAddresses.push(endpoint);
						newRestEndpoints++;
						logger.info(`NEW REST ENDPOINT: ${endpoint}`);
					}
				}
				logger.info(`Batch REST scan complete: saved ${validRestEndpoints.length} REST endpoints`);
			}

			// PEX augmentation: once, use the P2P seeds gathered from net_info to
			// gossip a wider peer set than the RPC view exposes, then scan it.
			if (PEX_ENABLED && !pexRan && batchPexSeeds.size > 0) {
				pexRan = true;
				const remainingSec = Math.floor((crawlDeadline - Date.now()) / 1000);
				const pexPeers = await discoverPexPeers({
					seeds: [...batchPexSeeds].slice(0, 64),
					network: expectedChainId,
					timeoutSec: Math.min(PEX_TIMEOUT_SEC, Math.max(5, remainingSec)),
				});
				if (pexPeers.length > 0) {
					const hosts = pexPeers.map((p) => ({ host: p.ip, isIp: true }));
					const [pexRpc, pexRest] = await Promise.all([
						scanPeers(hosts, expectedChainId, PEER_SCAN_PORTS, checkHostPort, 'PEX-RPC', {
							expandedPorts: EXPANDED_RPC_PORTS,
							requireLiveForExpanded: true,
							deadline: crawlDeadline,
						}),
						scanPeers(hosts, expectedChainId, REST_SCAN_PORTS, checkRestHostPort, 'PEX-REST', {
							deadline: crawlDeadline,
						}),
					]);
					for (const endpoint of pexRpc) {
						if (!checkedUrls.has(endpoint)) {
							queue.push({ url: endpoint, depth: 1 });
						}
					}
					chainsData[chainName].restAddresses ||= [];
					for (const endpoint of pexRest) {
						if (!chainsData[chainName].restAddresses.includes(endpoint)) {
							chainsData[chainName].restAddresses.push(endpoint);
							newRestEndpoints++;
						}
					}
					logger.info(
						`PEX expansion: ${pexPeers.length} peers -> ${pexRpc.length} RPC, ${pexRest.length} REST endpoints`
					);
				}
			}

			// Periodic save
			if (newEndpoints + newRestEndpoints > 0 && (newEndpoints + newRestEndpoints) % 10 === 0) {
				logger.info(
					`Periodic save: ${newEndpoints} new RPC endpoints, ${newRestEndpoints} new REST endpoints so far`
				);
				saveChainsData(chainsData);
				saveGoodIPs(goodIPs);
				saveRejectedIPs([...rejectedIPs]);
				saveBlacklistedIPs(blacklistedIPs);
			}
		}
	} catch (err) {
		logger.error(`Unexpected error during crawl for ${chainName}`, err);
	} finally {
		saveChainsData(chainsData);
		saveGoodIPs(goodIPs);
		saveRejectedIPs([...rejectedIPs]);
		saveBlacklistedIPs(blacklistedIPs);
	}

	const totalEndpoints = chainsData[chainName].rpcAddresses.length;
	const totalRestEndpoints = chainsData[chainName].restAddresses?.length || 0;
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

	logger.info(`=== Crawl complete for ${chainName} ===`);
	logger.info(`Duration: ${elapsed}s`);
	logger.info(`New endpoints: ${newEndpoints}`);
	logger.info(`Total endpoints: ${totalEndpoints}`);
	logger.info(`New REST endpoints: ${newRestEndpoints}`);
	logger.info(`Total REST endpoints: ${totalRestEndpoints}`);
	logger.info(`Misplaced endpoints: ${misplacedEndpoints}`);
	logger.info(`URLs checked: ${checkedUrls.size}`);
	logger.info(`Duplicate nodes skipped: ${skippedDuplicateNodes}`);

	return {
		newEndpoints,
		totalEndpoints,
		misplacedEndpoints,
		newRestEndpoints,
		totalRestEndpoints,
	};
}

export async function crawlAllChains(): Promise<Record<string, CrawlResult>> {
	logger.info('=== Starting crawl for ALL chains ===');

	const chainsData = loadChainsData();
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
