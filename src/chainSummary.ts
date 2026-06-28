import type { ChainEntry, ChainSummary } from './types.ts';

export function summarizeChains(chainsData: Record<string, ChainEntry>): ChainSummary[] {
	return Object.entries(chainsData)
		.map(([name, data]) => {
			const rpcCount = data.rpcAddresses.length;
			const restCount = data.restAddresses?.length || 0;

			return {
				name,
				chainId: data.chainId,
				bech32Prefix: data.bech32Prefix,
				endpointCount: rpcCount + restCount,
				rpcCount,
				restCount,
				source: 'chain-registry' as const,
				timestamp: data.timestamp,
				lastUpdated: data.lastUpdated,
				lastCrawled: data.lastCrawled,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
