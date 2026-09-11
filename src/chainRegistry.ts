import { REPO_NAME, REPO_OWNER } from './config.ts';
import { appLogger as logger } from './logger.ts';
import type { ChainEntry, ChainRegistryData, GithubContent } from './types.ts';
import { saveChainsData } from './utils.ts';

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
