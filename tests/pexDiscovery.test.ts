import { describe, expect, it } from 'vitest';
import { discoverPexPeers } from '../src/pexDiscovery';

describe('PEX discovery', () => {
	it('returns no peers without seeds or network', async () => {
		expect(await discoverPexPeers({ seeds: [], network: 'osmosis-1' })).toEqual([]);
		expect(await discoverPexPeers({ seeds: ['a@1.2.3.4:26656'], network: '' })).toEqual([]);
	});

	it('ignores unparseable seeds without dialing', async () => {
		expect(await discoverPexPeers({ seeds: ['not-a-seed'], network: 'osmosis-1' })).toEqual([]);
	});
});
