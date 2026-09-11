// PEX (peer-exchange) discovery over CometBFT's native P2P protocol. Dials the
// seeds derived from RPC /net_info and asks each for gossiped peer addresses,
// which see more of the network than the RPC view alone.
import { crawlerLogger as logger } from './logger.ts';
import { type DiscoveredPeer, TendermintPeer, parseSeed } from './p2p/tendermintPex.ts';

export interface PexPeer {
	id: string;
	ip: string;
	port: number;
}

export const PEX_TIMEOUT_SEC = Number(process.env.PEX_TIMEOUT) || 45;
export const PEX_ENABLED = process.env.PEX_ENABLED !== 'false';
const MAX_SEEDS = 64;
const CONCURRENCY = 16;

export async function discoverPexPeers({
	seeds,
	network,
	timeoutSec = PEX_TIMEOUT_SEC,
}: {
	seeds: string[];
	network: string;
	timeoutSec?: number;
}): Promise<PexPeer[]> {
	if (seeds.length === 0 || !network) return [];

	const deadline = Date.now() + timeoutSec * 1000;
	const parsed = seeds
		.map(parseSeed)
		.filter((seed): seed is NonNullable<typeof seed> => seed !== null)
		.slice(0, MAX_SEEDS);

	const found = new Map<string, DiscoveredPeer>();
	let next = 0;

	const worker = async (): Promise<void> => {
		while (next < parsed.length) {
			const seed = parsed[next++];
			const remaining = deadline - Date.now();
			if (remaining <= 0) return;
			try {
				const peer = await TendermintPeer.dial(seed, network, Math.min(remaining, 8000));
				try {
					for (const addr of await peer.requestPeers()) {
						if (!found.has(addr.ip)) found.set(addr.ip, addr);
					}
				} finally {
					peer.close();
				}
			} catch (err) {
				logger.debug(`PEX dial failed for ${seed.host}:${seed.port}`, err);
			}
		}
	};

	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parsed.length) }, worker));

	logger.info(`PEX discovered ${found.size} peers from ${parsed.length} seeds`);
	return [...found.values()].map(({ id, ip, port }) => ({ id, ip, port }));
}
