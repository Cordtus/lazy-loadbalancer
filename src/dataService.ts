import { REPO_NAME, REPO_OWNER } from './config.ts';
import { appLogger as logger } from './logger.ts';
// Data service using Bun's native file APIs
import type {
	BlacklistedIP,
	ChainEntry,
	ChainRegistryData,
	CleanupResult,
	GithubContent,
} from './types.ts';
import * as utils from './utils.ts';

class DataService {
	private async fetchChainFromGithub(chainName: string): Promise<ChainEntry | null> {
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

			const rpcAddresses: string[] = [];
			if (data.apis?.rpc && Array.isArray(data.apis.rpc)) {
				rpcAddresses.push(...data.apis.rpc.map((r) => r.address).filter(Boolean));
			}

			if (rpcAddresses.length === 0) {
				logger.warn(`No RPC addresses for chain: ${chainName}`);
				return null;
			}

			return {
				chainName: data.chain_name,
				chainId: data.chain_id,
				bech32Prefix: data.bech32_prefix,
				rpcAddresses,
				timeout: '30s',
				timestamp: Date.now(),
			};
		} catch (err) {
			logger.error(`Error fetching chain ${chainName}`, err);
			return null;
		}
	}

	async fetchChainsFromGitHub(): Promise<void> {
		try {
			logger.info('Fetching chains from GitHub...');

			const response = await fetch(
				`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents`
			);
			if (!response.ok) {
				throw new Error(`GitHub API request failed: ${response.status}`);
			}

			const contents = (await response.json()) as GithubContent[];
			const chainsData: Record<string, ChainEntry> = {};

			// Process chains in batches for efficiency
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
				const results = await Promise.all(
					batch.map((item) => this.fetchChainFromGithub(item.name))
				);

				for (let j = 0; j < batch.length; j++) {
					const chainData = results[j];
					if (chainData) {
						chainsData[batch[j].name] = chainData;
						logger.debug(`Fetched chain: ${batch[j].name}`);
					}
				}
			}

			await this.saveChainsData(chainsData);
			logger.info(`Fetched and saved ${Object.keys(chainsData).length} chains from GitHub`);
		} catch (err) {
			logger.error('Error fetching chains from GitHub', err);
			throw err;
		}
	}

	async loadChainsData(): Promise<Record<string, ChainEntry>> {
		return utils.loadChainsData();
	}

	async saveChainsData(chainsData: Record<string, ChainEntry>): Promise<void> {
		utils.saveChainsData(chainsData);
	}

	async getChain(chainName: string): Promise<ChainEntry | null> {
		const chainsData = utils.loadChainsData();
		return chainsData[chainName] || null;
	}

	async loadBlacklistedIPs(): Promise<BlacklistedIP[]> {
		return utils.loadBlacklistedIPs();
	}

	async saveBlacklistedIPs(blacklistedIPs: BlacklistedIP[]): Promise<void> {
		utils.saveBlacklistedIPs(blacklistedIPs);
	}

	async cleanupBlacklist(): Promise<CleanupResult> {
		return utils.cleanupBlacklist();
	}

	loadPorts(): number[] {
		return utils.loadPorts();
	}

	savePorts(ports: number[]): void {
		utils.savePorts(ports);
	}

	loadRejectedIPs(): string[] {
		return utils.loadRejectedIPs();
	}

	saveRejectedIPs(rejectedIPs: string[]): void {
		utils.saveRejectedIPs(rejectedIPs);
	}

	loadGoodIPs(): Record<string, number> {
		return utils.loadGoodIPs();
	}

	saveGoodIPs(goodIPs: Record<string, number>): void {
		utils.saveGoodIPs(goodIPs);
	}
}

export const dataService = new DataService();
export default dataService;
