import { describe, expect, it } from 'vitest';
import { extractP2pSeeds } from '../src/chainRegistry';

describe('extractP2pSeeds', () => {
	it('joins the registry id + address into nodeID@host:port seeds', () => {
		// Shape taken from cosmos/chain-registry cosmoshub/chain.json.
		const seeds = extractP2pSeeds({
			seeds: [
				{ id: 'ade4d8bc8cbe014af6ebdf3cb7b1e9ad36f412c0', address: 'seeds.polkachu.com:14956' },
			],
			persistent_peers: [
				{ id: 'd6318b3bd51a5e2b8ed08f2e520d50289ed32bf1', address: '52.79.43.100:26656' },
			],
		});

		expect(seeds).toEqual([
			'ade4d8bc8cbe014af6ebdf3cb7b1e9ad36f412c0@seeds.polkachu.com:14956',
			'd6318b3bd51a5e2b8ed08f2e520d50289ed32bf1@52.79.43.100:26656',
		]);
	});

	it('drops incomplete peers and deduplicates', () => {
		expect(
			extractP2pSeeds({
				seeds: [
					{ address: 'no-id.example.com:26656' },
					{ id: 'abc', address: '' },
					{ id: 'dup', address: '1.2.3.4:26656' },
					{ id: 'dup', address: '1.2.3.4:26656' },
				],
			})
		).toEqual(['dup@1.2.3.4:26656']);
	});

	it('handles missing peers', () => {
		expect(extractP2pSeeds(undefined)).toEqual([]);
		expect(extractP2pSeeds({})).toEqual([]);
	});
});
