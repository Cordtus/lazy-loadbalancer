import { REPO_NAME, REPO_OWNER } from './config.ts';
import { appLogger as logger } from './logger.ts';
import type { ChainEntry, ChainRegistryData, GithubContent } from './types.ts';
import { saveChainsData } from './utils.ts';

// Registry peers are `{ id, address }` where address is `host:port`; PEX wants
// `nodeID@host:port`, so join them and drop incomplete entries.
export function extractP2pSeeds(peers: ChainRegistryData['peers']): string[] {
	const seeds: string[] = [];
	for (const section of [peers?.seeds, peers?.persistent_peers]) {
		for (const peer of section ?? []) {
			const id = typeof peer?.id === 'string' ? peer.id.trim() : '';
			const address = typeof peer?.address === 'string' ? peer.address.trim() : '';
			if (id && address) seeds.push(`${id}@${address}`);
		}
	}
	return [...new Set(seeds)];
}

async function fetchChainFromGithub(chainName: string): Promise<ChainEntry | null> {
	const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/${chainName}/chain.json`;

	try {
		const response = await fetch(url);
		if (!response.ok) {
			logger.warn(`Failed to fetch chain: ${chainName}`);
			return null;
		}

		const data = (await response.json()) as ChainRegistryData;

		if (!data.chain_name || !data.chain_id || !data.bech32_prefix) {
			logger.warn(`Invalid chain data for ${chainName}: missing required fields`);
			return null;
		}

		const rpcAddresses = (data.apis?.rpc || []).map((r) => r.address).filter(Boolean);
		const restAddresses = (data.apis?.rest || []).map((r) => r.address).filter(Boolean);
		const p2pSeeds = extractP2pSeeds(data.peers);

		if (rpcAddresses.length === 0 && restAddresses.length === 0) {
			logger.warn(`No RPC or REST addresses for chain: ${chainName}`);
			return null;
		}

		return {
			chainName: data.chain_name,
			chainId: data.chain_id,
			bech32Prefix: data.bech32_prefix,
			rpcAddresses,
			restAddresses,
			p2pSeeds,
			timeout: '30s',
			timestamp: Date.now(),
		};
	} catch (err) {
		logger.error(`Error fetching chain ${chainName}`, err);
		return null;
	}
}

export async function fetchChainsFromGitHub(): Promise<void> {
	logger.info('Fetching chains from GitHub...');

	const response = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents`);
	if (!response.ok) {
		throw new Error(`GitHub API request failed: ${response.status}`);
	}

	const contents = (await response.json()) as GithubContent[];
	const chainsData: Record<string, ChainEntry> = {};

	const chainDirs = contents.filter(
		(item) =>
			item.type === 'dir' &&
			!item.name.startsWith('.') &&
			!item.name.startsWith('_') &&
			item.name !== 'testnets'
	);

	const batchSize = 10;
	for (let i = 0; i < chainDirs.length; i += batchSize) {
		const batch = chainDirs.slice(i, i + batchSize);
		const results = await Promise.all(batch.map((item) => fetchChainFromGithub(item.name)));

		for (let j = 0; j < batch.length; j++) {
			const chainData = results[j];
			if (chainData) {
				chainsData[batch[j].name] = chainData;
				logger.debug(`Fetched chain: ${batch[j].name}`);
			}
		}
	}

	saveChainsData(chainsData);
	logger.info(`Fetched and saved ${Object.keys(chainsData).length} chains from GitHub`);
}
