import { describe, expect, it } from 'vitest';
import {
	clearIbcLinkCaches,
	resolveChainAlias,
	resolveIbcLinksFromChainRegistry,
	resolveIbcLinksFromRegistryFiles,
} from '../src/ibcLinks';
import type { ChainEntry, IbcRegistryFile } from '../src/types';

const chainsData: Record<string, ChainEntry> = {
	genesisl1: {
		chainName: 'genesisl1',
		chainId: 'genesis_29-2',
		bech32Prefix: 'genesis',
		rpcAddresses: ['https://rpc.genesis.example.com'],
		restAddresses: ['https://rest.genesis.example.com'],
	},
	osmosis: {
		chainName: 'osmosis',
		chainId: 'osmosis-1',
		bech32Prefix: 'osmo',
		rpcAddresses: ['https://rpc.osmosis.example.com'],
		restAddresses: ['https://rest.osmosis.example.com'],
	},
};

const genesisOsmosis: IbcRegistryFile = {
	chain_1: {
		chain_name: 'genesisl1',
		client_id: '07-tendermint-1',
		connection_id: 'connection-1',
	},
	chain_2: {
		chain_name: 'osmosis',
		client_id: '07-tendermint-1983',
		connection_id: 'connection-1539',
	},
	channels: [
		{
			chain_1: {
				channel_id: 'channel-0',
				port_id: 'transfer',
			},
			chain_2: {
				channel_id: 'channel-700',
				port_id: 'transfer',
			},
			ordering: 'unordered',
			version: 'ics20-1',
			tags: {
				preferred: true,
				status: 'INACTIVE',
			},
		},
		{
			chain_1: {
				channel_id: 'channel-1',
				port_id: 'transfer',
			},
			chain_2: {
				channel_id: 'channel-253',
				port_id: 'transfer',
			},
			ordering: 'unordered',
			version: 'ics20-1',
			tags: {
				status: 'ACTIVE',
				preferred: true,
				dex: 'osmosis',
			},
		},
	],
};

describe('IBC link resolution', () => {
	it('resolves chain names and chain IDs to canonical chain names', () => {
		expect(resolveChainAlias('genesisl1', chainsData)).toBe('genesisl1');
		expect(resolveChainAlias('GENESIS_29-2', chainsData)).toBe('genesisl1');
		expect(resolveChainAlias('osmosis-1', chainsData)).toBe('osmosis');
		expect(resolveChainAlias('unknown-1', chainsData)).toBeNull();
	});

	it('maps registry links from the source chain perspective and sorts preferred active links first', () => {
		const result = resolveIbcLinksFromRegistryFiles({
			source: 'genesis_29-2',
			destination: 'osmosis-1',
			chainsData,
			files: [{ name: 'genesisl1-osmosis.json', data: genesisOsmosis }],
		});

		expect(result.source).toEqual({
			name: 'genesisl1',
			chainId: 'genesis_29-2',
		});
		expect(result.destination).toEqual({
			name: 'osmosis',
			chainId: 'osmosis-1',
		});
		expect(result.links.map((link) => link.channelId)).toEqual(['channel-1', 'channel-0']);
		expect(result.links[0]).toEqual({
			sourceChainName: 'genesisl1',
			sourceChainId: 'genesis_29-2',
			destinationChainName: 'osmosis',
			destinationChainId: 'osmosis-1',
			channelId: 'channel-1',
			portId: 'transfer',
			counterpartyChannelId: 'channel-253',
			counterpartyPortId: 'transfer',
			clientId: '07-tendermint-1',
			counterpartyClientId: '07-tendermint-1983',
			connectionId: 'connection-1',
			counterpartyConnectionId: 'connection-1539',
			ordering: 'unordered',
			version: 'ics20-1',
			tags: {
				status: 'ACTIVE',
				preferred: true,
				dex: 'osmosis',
			},
			sourceFile: 'genesisl1-osmosis.json',
		});
	});

	it('maps the same registry file in reverse when source and destination are swapped', () => {
		const result = resolveIbcLinksFromRegistryFiles({
			source: 'osmosis',
			destination: 'genesisl1',
			chainsData,
			files: [{ name: 'genesisl1-osmosis.json', data: genesisOsmosis }],
		});

		expect(result.links[0]).toMatchObject({
			sourceChainName: 'osmosis',
			destinationChainName: 'genesisl1',
			channelId: 'channel-253',
			counterpartyChannelId: 'channel-1',
			clientId: '07-tendermint-1983',
			counterpartyClientId: '07-tendermint-1',
		});
	});

	it('uses channel-level client and connection overrides when registry channels provide them', () => {
		const result = resolveIbcLinksFromRegistryFiles({
			source: 'genesisl1',
			destination: 'osmosis',
			chainsData,
			files: [
				{
					name: 'genesisl1-osmosis.json',
					data: {
						chain_1: {
							chain_name: 'genesisl1',
							client_id: '07-tendermint-1',
							connection_id: 'connection-1',
						},
						chain_2: {
							chain_name: 'osmosis',
							client_id: '07-tendermint-1983',
							connection_id: 'connection-1539',
						},
						channels: [
							{
								chain_1: {
									channel_id: 'channel-69',
									port_id: 'transfer',
									client_id: '07-tendermint-103',
									connection_id: 'connection-89',
								},
								chain_2: {
									channel_id: 'channel-61',
									port_id: 'transfer',
									client_id: '07-tendermint-120',
									connection_id: 'connection-93',
								},
								ordering: 'unordered',
								version: 'ics20-1',
								tags: {
									preferred: true,
									status: 'ACTIVE',
								},
							},
						],
					},
				},
			],
		});

		expect(result.links[0]).toMatchObject({
			clientId: '07-tendermint-103',
			connectionId: 'connection-89',
			counterpartyClientId: '07-tendermint-120',
			counterpartyConnectionId: 'connection-93',
		});
	});

	it('surfaces matching IBC registry file fetch failures', async () => {
		clearIbcLinkCaches();
		const fetchFn = async (url: string | URL | Request) => {
			const textUrl = String(url);
			if (textUrl.includes('/contents/_IBC')) {
				return Response.json([
					{
						name: 'genesisl1-osmosis.json',
						type: 'file',
						download_url: 'https://raw.example.com/genesisl1-osmosis.json',
					},
				]);
			}

			return new Response('unavailable', { status: 503 });
		};

		await expect(
			resolveIbcLinksFromChainRegistry({
				source: 'genesisl1',
				destination: 'osmosis',
				chainsData,
				fetchFn: fetchFn as typeof fetch,
				now: () => 1700000000000,
			})
		).rejects.toThrow(/HTTP 503/);
	});
});
