// PEX (peer-exchange) discovery over CometBFT's native P2P protocol. Dials the
// seeds derived from RPC /net_info, asks each for gossiped peer addresses, then
// breadth-first dials the peers it learns about. Each PexRequest returns only a
// random subset of a peer's address book, so every peer is queried several times.
import { envInt } from './config.ts';
import { crawlerLogger as logger } from './logger.ts';
import { type DiscoveredPeer, TendermintPeer, parseSeed } from './p2p/tendermintPex.ts';
import { isPrivateIP } from './utils.ts';

export interface PexPeer {
	id: string;
	ip: string;
	port: number;
}

export const PEX_TIMEOUT_SEC = envInt('PEX_TIMEOUT', 45);
export const PEX_ENABLED = process.env.PEX_ENABLED !== 'false';
const MAX_QUERIES = Math.max(1, envInt('PEX_MAX_QUERIES', 3));
const MAX_DIALS = Math.max(1, envInt('PEX_MAX_DIALS', 256));
const MAX_DIAL_ATTEMPTS = Math.max(1, envInt('PEX_DIAL_ATTEMPTS', 2));
const CONCURRENCY = Math.max(1, envInt('PEX_CONCURRENCY', 16));
const QUERY_GAP_MS = 3000;
const DIAL_TIMEOUT_MS = 8000;

interface PexSeed {
	id: string;
	host: string;
	port: number;
}

// Minimal surface of a dialed peer; lets tests inject a fake dialer.
export type PexDialer = (
	seed: PexSeed,
	network: string,
	timeoutMs: number
) => Promise<{ requestPeers(): Promise<DiscoveredPeer[]>; close(): void }>;

interface CrawlOptions {
	seeds: string[];
	network: string;
	timeoutSec?: number;
	maxQueries?: number;
	maxDials?: number;
	maxDialAttempts?: number;
	concurrency?: number;
	queryGapMs?: number;
	deadline?: number;
}

function isRoutablePexIp(ip: string): boolean {
	// Strict dotted-quad check: gossip can carry malformed/out-of-range values,
	// and isPrivateIP returns false for anything that is not exactly 4 octets.
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
	if (ip.split('.').some((o) => Number(o) > 255)) return false;
	return !isPrivateIP(ip);
}

export async function crawlPex(dial: PexDialer, options: CrawlOptions): Promise<PexPeer[]> {
	const {
		seeds,
		network,
		timeoutSec = PEX_TIMEOUT_SEC,
		maxQueries = MAX_QUERIES,
		maxDials = MAX_DIALS,
		maxDialAttempts = MAX_DIAL_ATTEMPTS,
		concurrency = CONCURRENCY,
		queryGapMs = QUERY_GAP_MS,
	} = options;
	if (seeds.length === 0 || !network) return [];

	const deadline = options.deadline ?? Date.now() + timeoutSec * 1000;
	const found = new Map<string, DiscoveredPeer>();
	const seenSeedKeys = new Set<string>();

	const initial: PexSeed[] = [];
	for (const raw of seeds) {
		const parsed = parseSeed(raw);
		if (!parsed) continue;
		const key = `${parsed.host}:${parsed.port}`;
		if (seenSeedKeys.has(key)) continue;
		seenSeedKeys.add(key);
		initial.push(parsed);
	}

	let pending = initial;
	let dials = 0;

	while (pending.length > 0 && dials < maxDials && Date.now() < deadline) {
		const batch = pending.slice(0, maxDials - dials);
		pending = [];
		const nextSeeds: PexSeed[] = [];
		let cursor = 0;

		const worker = async (): Promise<void> => {
			while (cursor < batch.length) {
				const seed = batch[cursor++];
				if (Date.now() >= deadline || dials >= maxDials) return;

				let peer: Awaited<ReturnType<PexDialer>> | null = null;
				for (let attempt = 0; attempt < maxDialAttempts && !peer; attempt++) {
					// Count every actual dial attempt against the budget.
					if (dials >= maxDials) break;
					dials++;
					try {
						const timeoutMs = Math.min(Math.max(deadline - Date.now(), 1000), DIAL_TIMEOUT_MS);
						peer = await dial(seed, network, timeoutMs);
					} catch (err) {
						logger.debug(`PEX dial failed for ${seed.host}:${seed.port}`, err);
						if (attempt < maxDialAttempts - 1) {
							await new Promise((r) => setTimeout(r, 1000));
						}
					}
				}
				if (!peer) continue;

				try {
					for (let q = 0; q < maxQueries; q++) {
						let addrs: DiscoveredPeer[];
						try {
							addrs = await peer.requestPeers();
						} catch (err) {
							logger.debug(`PEX request failed for ${seed.host}:${seed.port}`, err);
							break;
						}

						let added = false;
						for (const addr of addrs) {
							if (!isRoutablePexIp(addr.ip) || !addr.port || addr.port > 65535) continue;
							if (!found.has(addr.ip)) {
								found.set(addr.ip, addr);
								added = true;
							}
							const key = `${addr.ip}:${addr.port}`;
							if (!seenSeedKeys.has(key)) {
								seenSeedKeys.add(key);
								nextSeeds.push({ id: addr.id, host: addr.ip, port: addr.port });
								added = true;
							}
						}

						if (!added || q === maxQueries - 1 || Date.now() >= deadline) break;
						if (queryGapMs > 0) await new Promise((r) => setTimeout(r, queryGapMs));
					}
				} finally {
					peer.close();
				}
			}
		};

		await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
		pending = nextSeeds;
	}

	logger.info(`PEX discovered ${found.size} peers in ${dials} dial attempts`);
	return [...found.values()].map(({ id, ip, port }) => ({ id, ip, port }));
}

export async function discoverPexPeers({
	seeds,
	network,
	timeoutSec = PEX_TIMEOUT_SEC,
}: {
	seeds: string[];
	network: string;
	timeoutSec?: number;
}): Promise<PexPeer[]> {
	return crawlPex((seed, net, timeoutMs) => TendermintPeer.dial(seed, net, timeoutMs), {
		seeds,
		network,
		timeoutSec,
	});
}

export const _test_crawlPex = crawlPex;
