import { describe, expect, it } from 'vitest';
import { summarizeChains } from '../src/chainSummary';

describe('chain summaries', () => {
	it('includes registry metadata and endpoint counts for chain selection', () => {
		expect(
			summarizeChains({
				cosmoshub: {
					chainName: 'cosmoshub',
					chainId: 'cosmoshub-4',
					bech32Prefix: 'cosmos',
					rpcAddresses: ['https://rpc.example.com'],
					restAddresses: ['https://rest.example.com', 'https://rest2.example.com'],
					timestamp: 1700000000000,
				},
			})
		).toEqual([
			{
				name: 'cosmoshub',
				chainId: 'cosmoshub-4',
				bech32Prefix: 'cosmos',
				endpointCount: 3,
				rpcCount: 1,
				restCount: 2,
				source: 'chain-registry',
				timestamp: 1700000000000,
			},
		]);
	});

	it('sorts summaries by chain name', () => {
		expect(
			summarizeChains({
				osmosis: {
					chainName: 'osmosis',
					chainId: 'osmosis-1',
					bech32Prefix: 'osmo',
					rpcAddresses: ['https://rpc.osmosis.example.com'],
					restAddresses: [],
				},
				cosmoshub: {
					chainName: 'cosmoshub',
					chainId: 'cosmoshub-4',
					bech32Prefix: 'cosmos',
					rpcAddresses: ['https://rpc.cosmos.example.com'],
					restAddresses: ['https://rest.cosmos.example.com'],
				},
			}).map((chain) => chain.name)
		).toEqual(['cosmoshub', 'osmosis']);
	});
});
