import { describe, expect, it } from 'vitest';
import { type PexDialer, _test_crawlPex, discoverPexPeers } from '../src/pexDiscovery';

describe('PEX discovery', () => {
	it('returns no peers without seeds or network', async () => {
		expect(await discoverPexPeers({ seeds: [], network: 'osmosis-1' })).toEqual([]);
		expect(await discoverPexPeers({ seeds: ['a@1.2.3.4:26656'], network: '' })).toEqual([]);
	});

	it('ignores unparseable seeds without dialing', async () => {
		expect(await discoverPexPeers({ seeds: ['not-a-seed'], network: 'osmosis-1' })).toEqual([]);
	});
});

describe('PEX breadth-first crawl', () => {
	it('multi-queries each peer and dials the peers it discovers', async () => {
		const calls: string[] = [];
		// Each PexRequest returns a different subset, mimicking a real peer.
		const responses: Record<string, Array<Array<{ id: string; ip: string; port: number }>>> = {
			'1.1.1.1:26656': [
				[{ id: 'b', ip: '2.2.2.2', port: 26656 }],
				[{ id: 'c', ip: '3.3.3.3', port: 26656 }],
			],
			'2.2.2.2:26656': [[{ id: 'd', ip: '4.4.4.4', port: 26656 }]],
			'3.3.3.3:26656': [[]],
		};
		const dial: PexDialer = async (seed) => {
			const key = `${seed.host}:${seed.port}`;
			calls.push(key);
			let n = 0;
			return {
				requestPeers: async () => responses[key]?.[n++] ?? [],
				close: () => {},
			};
		};

		const peers = await _test_crawlPex(dial, {
			seeds: ['a@1.1.1.1:26656'],
			network: 'test-1',
			maxQueries: 3,
			maxDials: 10,
			concurrency: 4,
			queryGapMs: 0,
			timeoutSec: 5,
		});

		expect(peers.map((p) => p.ip).sort()).toEqual(['2.2.2.2', '3.3.3.3', '4.4.4.4']);
		// Peers gossiped in round one are dialed in round two (BFS).
		expect(calls).toContain('2.2.2.2:26656');
		expect(calls).toContain('3.3.3.3:26656');
		expect(calls).toContain('4.4.4.4:26656');
	});

	it('filters private, IPv6, malformed and portless addresses', async () => {
		const dial: PexDialer = async () => ({
			requestPeers: async () => [
				{ id: 'priv', ip: '10.0.0.1', port: 26656 },
				{ id: 'v6', ip: '2001:db8::1', port: 26656 },
				{ id: 'bad', ip: '999.1.1.1', port: 26656 },
				{ id: 'noport', ip: '5.5.5.5', port: 0 },
				{ id: 'bigport', ip: '5.5.5.5', port: 70000 },
				{ id: 'good', ip: '6.6.6.6', port: 26656 },
			],
			close: () => {},
		});

		const peers = await _test_crawlPex(dial, {
			seeds: ['a@1.1.1.1:26656'],
			network: 'test-1',
			maxQueries: 1,
			maxDials: 1,
			concurrency: 1,
			queryGapMs: 0,
			timeoutSec: 5,
		});

		expect(peers).toEqual([{ id: 'good', ip: '6.6.6.6', port: 26656 }]);
	});
});
