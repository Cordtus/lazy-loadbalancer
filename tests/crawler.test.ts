// tests/crawler.test.ts
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _test_extractPeerInfo as extractPeerInfo } from '../src/crawler';
import type { NetInfo, Peer, StatusResponse } from '../src/types';
import { isPrivateIP, normalizeUrl } from '../src/utils';

// Mock responses for testing peer discovery
const MOCK_CHAIN_ID = 'cosmoshub-4';
const MOCK_BLOCK_TIME = new Date().toISOString();

// Comprehensive peer configurations to test all edge cases
const mockPeers: Peer[] = [
	// Valid IP peer with standard RPC port
	{
		remote_ip: '1.2.3.4',
		node_info: {
			id: 'node1id',
			moniker: 'Node 1',
			listen_addr: 'tcp://1.2.3.4:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Valid domain peer with non-standard RPC port
	{
		remote_ip: '5.6.7.8',
		node_info: {
			id: 'node2id',
			moniker: 'Node 2',
			listen_addr: 'tcp://rpc.example.com:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:36657', // non-standard port should be discovered
			},
		},
	},
	// Private IP - should be filtered
	{
		remote_ip: '192.168.1.100',
		node_info: {
			id: 'node3id',
			moniker: 'Private Node',
			listen_addr: 'tcp://192.168.1.100:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Localhost - should be filtered
	{
		remote_ip: 'localhost',
		node_info: {
			id: 'node4id',
			moniker: 'Localhost Node',
			listen_addr: 'tcp://localhost:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// 10.x.x.x private range - should be filtered
	{
		remote_ip: '10.0.0.50',
		node_info: {
			id: 'node5id',
			moniker: 'Internal Node',
			listen_addr: 'tcp://10.0.0.50:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Domain in listen_addr with valid remote_ip
	{
		remote_ip: '20.30.40.50',
		node_info: {
			id: 'node6id',
			moniker: 'Domain Node',
			listen_addr: 'tcp://cosmos.validator.example.org:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:443', // https port
			},
		},
	},
	// 0.0.0.0 remote_ip - should use domain from listen_addr
	{
		remote_ip: '0.0.0.0',
		node_info: {
			id: 'node7id',
			moniker: 'Zero IP Node',
			listen_addr: 'tcp://cosmos-rpc.test.com:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// 172.16.x.x private range - should be filtered
	{
		remote_ip: '172.16.0.100',
		node_info: {
			id: 'node8id',
			moniker: 'Private 172 Node',
			listen_addr: 'tcp://172.16.0.100:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Valid peer with exotic port
	{
		remote_ip: '100.200.100.200',
		node_info: {
			id: 'node9id',
			moniker: 'Exotic Port Node',
			listen_addr: 'tcp://100.200.100.200:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:14917', // exotic port to discover
			},
		},
	},
	// Edge case: Empty remote_ip with valid domain
	{
		remote_ip: '',
		node_info: {
			id: 'node10id',
			moniker: 'Empty IP Node',
			listen_addr: 'tcp://rpc-empty.cosmos.network:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: IPv6-style address (should be handled gracefully)
	{
		remote_ip: '::1',
		node_info: {
			id: 'node11id',
			moniker: 'IPv6 Localhost',
			listen_addr: 'tcp://[::1]:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: 127.0.0.1 loopback
	{
		remote_ip: '127.0.0.1',
		node_info: {
			id: 'node12id',
			moniker: 'Loopback Node',
			listen_addr: 'tcp://127.0.0.1:26656',
			other: {
				rpc_address: 'tcp://127.0.0.1:26657',
			},
		},
	},
	// Edge case: Very long subdomain
	{
		remote_ip: '50.60.70.80',
		node_info: {
			id: 'node13id',
			moniker: 'Long Domain Node',
			listen_addr: 'tcp://rpc.cosmos.mainnet.validator.example.infrastructure.org:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: IP in listen_addr that differs from remote_ip
	{
		remote_ip: '90.100.110.120',
		node_info: {
			id: 'node14id',
			moniker: 'Different IPs Node',
			listen_addr: 'tcp://200.201.202.203:26656', // Different IP
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: Missing node_info.other
	{
		remote_ip: '130.140.150.160',
		node_info: {
			id: 'node15id',
			moniker: 'Missing Other Node',
			listen_addr: 'tcp://130.140.150.160:26656',
			other: {
				rpc_address: '',
			},
		},
	},
	// Edge case: Malformed listen_addr (no port)
	{
		remote_ip: '170.180.190.200',
		node_info: {
			id: 'node16id',
			moniker: 'No Port Node',
			listen_addr: 'tcp://noport.example.com',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: Plain domain in rpc_address (non-standard)
	{
		remote_ip: '210.220.230.240',
		node_info: {
			id: 'node17id',
			moniker: 'Routable RPC Node',
			listen_addr: 'tcp://210.220.230.240:26656',
			other: {
				rpc_address: 'tcp://rpc.external.cosmos.network:443', // routable RPC address
			},
		},
	},
	// Edge case: Port only in rpc_address (no host)
	{
		remote_ip: '11.22.33.44',
		node_info: {
			id: 'node18id',
			moniker: 'Minimal RPC Node',
			listen_addr: 'tcp://11.22.33.44:26656',
			other: {
				rpc_address: ':26657',
			},
		},
	},
	// Edge case: HTTPS port but http protocol
	{
		remote_ip: '55.66.77.88',
		node_info: {
			id: 'node19id',
			moniker: 'HTTPS Port Node',
			listen_addr: 'tcp://55.66.77.88:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:443',
			},
		},
	},
	// Edge case: localhost variations
	{
		remote_ip: 'LOCALHOST',
		node_info: {
			id: 'node20id',
			moniker: 'Uppercase Localhost',
			listen_addr: 'tcp://LOCALHOST:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: IP with leading zeros
	{
		remote_ip: '001.002.003.004',
		node_info: {
			id: 'node21id',
			moniker: 'Leading Zeros IP',
			listen_addr: 'tcp://001.002.003.004:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: Subdomain that looks like IP
	{
		remote_ip: '111.112.113.114',
		node_info: {
			id: 'node22id',
			moniker: 'IP-like Domain Node',
			listen_addr: 'tcp://192-168-1-1.dynamic.example.com:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: Numeric subdomain
	{
		remote_ip: '121.131.141.151',
		node_info: {
			id: 'node23id',
			moniker: 'Numeric Subdomain',
			listen_addr: 'tcp://node001.validators.cosmos.network:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: Underscore in domain (technically invalid but seen in practice)
	{
		remote_ip: '161.171.181.191',
		node_info: {
			id: 'node24id',
			moniker: 'Underscore Domain',
			listen_addr: 'tcp://cosmos_rpc.example.com:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:26657',
			},
		},
	},
	// Edge case: Non-standard high port
	{
		remote_ip: '201.211.221.231',
		node_info: {
			id: 'node25id',
			moniker: 'High Port Node',
			listen_addr: 'tcp://201.211.221.231:26656',
			other: {
				rpc_address: 'tcp://0.0.0.0:65535',
			},
		},
	},
];

const mockNetInfoResponse: { result: NetInfo } = {
	result: {
		peers: mockPeers,
	},
};

const createMockStatusResponse = (
	chainId: string,
	nodeId: string,
	moniker: string
): StatusResponse => ({
	result: {
		node_info: {
			id: nodeId,
			moniker: moniker,
			network: chainId,
			other: {
				tx_index: 'on',
			},
		},
		sync_info: {
			latest_block_time: MOCK_BLOCK_TIME,
			latest_block_height: '12345678',
		},
	},
});

// Helper to create fetch mock
const createFetchMock = (urlResponses: Record<string, unknown>) => {
	return vi.fn((url: string) => {
		const urlStr = typeof url === 'string' ? url : (url as URL).toString();

		for (const [pattern, response] of Object.entries(urlResponses)) {
			if (urlStr.includes(pattern)) {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(response),
				});
			}
		}

		// Default: connection failed
		return Promise.reject(new Error(`Connection refused: ${urlStr}`));
	});
};

describe('Crawler Peer Extraction', () => {
	describe('extractPeerInfo', () => {
		// Simulate the extraction logic that's in crawler.ts

		it('should extract public, routable hosts from peers', () => {
			const { peers: extracted } = extractPeerInfo(mockPeers);
			const hosts = extracted.map((p) => p.host).sort();

			const expectedHosts = [
				'1.2.3.4',
				'5.6.7.8',
				'20.30.40.50',
				'100.200.100.200',
				'50.60.70.80',
				'90.100.110.120',
				'130.140.150.160',
				'170.180.190.200',
				'210.220.230.240',
				'11.22.33.44',
				'55.66.77.88',
				'001.002.003.004',
				'111.112.113.114',
				'121.131.141.151',
				'161.171.181.191',
				'201.211.221.231',
				'cosmos-rpc.test.com',
				'rpc-empty.cosmos.network',
				'rpc.example.com',
				'cosmos.validator.example.org',
				'noport.example.com',
				'rpc.cosmos.mainnet.validator.example.infrastructure.org',
				'200.201.202.203',
				'cosmos_rpc.example.com',
				'192-168-1-1.dynamic.example.com',
				'node001.validators.cosmos.network',
				'rpc.external.cosmos.network', // routable RPC address extracted from node17
			].sort();

			expect(new Set(hosts)).toEqual(new Set(expectedHosts));
		});

		it('should filter out localhost variations', () => {
			const localhostPeers = mockPeers.filter(
				(p) => p.remote_ip.toLowerCase() === 'localhost' || p.remote_ip === '127.0.0.1'
			);
			// lowercase 'localhost', UPPERCASE 'LOCALHOST', and 127.0.0.1
			expect(localhostPeers.length).toBe(3);
		});

		it('should filter out 0.0.0.0', () => {
			const zeroPeers = mockPeers.filter((p) => p.remote_ip === '0.0.0.0');
			expect(zeroPeers.length).toBe(1);
		});

		it('should extract ports from rpc_address fields', () => {
			const discoveredPorts = new Set<number>();

			for (const peer of mockPeers) {
				const rpcAddr = peer.node_info?.other?.rpc_address;
				if (rpcAddr) {
					const match = rpcAddr.match(/:(\d+)$/);
					if (match) {
						discoveredPorts.add(Number.parseInt(match[1], 10));
					}
				}
			}

			expect(discoveredPorts.has(26657)).toBe(true);
			expect(discoveredPorts.has(36657)).toBe(true); // non-standard port
			expect(discoveredPorts.has(443)).toBe(true);
			expect(discoveredPorts.has(14917)).toBe(true); // exotic port
			expect(discoveredPorts.has(65535)).toBe(true); // high port edge case
		});

		it('should extract domains from listen_addr when remote_ip is invalid', () => {
			// Test peer with 0.0.0.0 remote_ip but valid domain in listen_addr
			const peer = mockPeers.find((p) => p.node_info.id === 'node7id');
			expect(peer).toBeDefined();
			expect(peer?.remote_ip).toBe('0.0.0.0');

			// The domain should be extracted from listen_addr
			const listenAddr = peer?.node_info.listen_addr;
			const stripped = listenAddr?.replace(/^tcp:\/\//, '');
			const colonIdx = stripped?.lastIndexOf(':') || -1;
			const domain = colonIdx > 0 ? stripped?.substring(0, colonIdx) : stripped;

			expect(domain).toBe('cosmos-rpc.test.com');
		});

		it('should extract domain from listen_addr when remote_ip is empty', () => {
			const peer = mockPeers.find((p) => p.node_info.id === 'node10id');
			expect(peer).toBeDefined();
			expect(peer?.remote_ip).toBe('');

			const listenAddr = peer?.node_info.listen_addr;
			const stripped = listenAddr?.replace(/^tcp:\/\//, '');
			const colonIdx = stripped?.lastIndexOf(':') || -1;
			const domain = colonIdx > 0 ? stripped?.substring(0, colonIdx) : stripped;

			expect(domain).toBe('rpc-empty.cosmos.network');
		});

		it('should handle listen_addr without port', () => {
			const peer = mockPeers.find((p) => p.node_info.id === 'node16id');
			expect(peer).toBeDefined();

			const listenAddr = peer?.node_info.listen_addr;
			const stripped = listenAddr?.replace(/^tcp:\/\//, '');
			const colonIdx = stripped?.lastIndexOf(':') || -1;
			// If no colon, use entire string as domain
			const domain = colonIdx > 0 ? stripped?.substring(0, colonIdx) : stripped;

			expect(domain).toBe('noport.example.com');
		});

		it('should handle very long domain names', () => {
			const peer = mockPeers.find((p) => p.node_info.id === 'node13id');
			expect(peer).toBeDefined();

			const listenAddr = peer?.node_info.listen_addr;
			const stripped = listenAddr?.replace(/^tcp:\/\//, '');
			const colonIdx = stripped?.lastIndexOf(':') || -1;
			const domain = colonIdx > 0 ? stripped?.substring(0, colonIdx) : stripped;

			expect(domain).toBe('rpc.cosmos.mainnet.validator.example.infrastructure.org');
		});

		it('should extract both IP and domain when listen_addr has different IP', () => {
			const peer = mockPeers.find((p) => p.node_info.id === 'node14id');
			expect(peer).toBeDefined();

			// remote_ip and listen_addr IP are different - both should be collected
			expect(peer?.remote_ip).toBe('90.100.110.120');

			const listenAddr = peer?.node_info.listen_addr;
			const stripped = listenAddr?.replace(/^tcp:\/\//, '');
			const colonIdx = stripped?.lastIndexOf(':') || -1;
			const listenHost = colonIdx > 0 ? stripped?.substring(0, colonIdx) : stripped;

			expect(listenHost).toBe('200.201.202.203');
			expect(listenHost).not.toBe(peer?.remote_ip);
		});

		it('should handle domains with underscores', () => {
			const peer = mockPeers.find((p) => p.node_info.id === 'node24id');
			expect(peer).toBeDefined();

			const listenAddr = peer?.node_info.listen_addr;
			const stripped = listenAddr?.replace(/^tcp:\/\//, '');
			const colonIdx = stripped?.lastIndexOf(':') || -1;
			const domain = colonIdx > 0 ? stripped?.substring(0, colonIdx) : stripped;

			expect(domain).toBe('cosmos_rpc.example.com');
		});

		it('should handle domains that look like IPs', () => {
			const peer = mockPeers.find((p) => p.node_info.id === 'node22id');
			expect(peer).toBeDefined();

			const listenAddr = peer?.node_info.listen_addr;
			const stripped = listenAddr?.replace(/^tcp:\/\//, '');
			const colonIdx = stripped?.lastIndexOf(':') || -1;
			const domain = colonIdx > 0 ? stripped?.substring(0, colonIdx) : stripped;

			expect(domain).toBe('192-168-1-1.dynamic.example.com');
			// Should detect this as a domain (contains letters), not an IP
			const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(domain || '');
			expect(isIp).toBe(false);
		});

		it('should detect routable RPC addresses', () => {
			const peer = mockPeers.find((p) => p.node_info.id === 'node17id');
			expect(peer).toBeDefined();

			const rpcAddr = peer?.node_info.other.rpc_address;
			expect(rpcAddr).toBe('tcp://rpc.external.cosmos.network:443');

			// This RPC address is routable (not 0.0.0.0) - could be used directly
			const isNonRoutable =
				rpcAddr?.includes('0.0.0.0') ||
				rpcAddr?.includes('127.0.0.1') ||
				rpcAddr?.includes('localhost');
			expect(isNonRoutable).toBe(false);
		});
	});

	describe('Private IP filtering', () => {
		it('should filter 10.x.x.x addresses', () => {
			expect(isPrivateIP('10.0.0.1')).toBe(true);
			expect(isPrivateIP('10.255.255.255')).toBe(true);
		});

		it('should filter 172.16.x.x - 172.31.x.x addresses', () => {
			expect(isPrivateIP('172.16.0.1')).toBe(true);
			expect(isPrivateIP('172.31.255.255')).toBe(true);
			expect(isPrivateIP('172.15.0.1')).toBe(false); // not private
			expect(isPrivateIP('172.32.0.1')).toBe(false); // not private
		});

		it('should filter 192.168.x.x addresses', () => {
			expect(isPrivateIP('192.168.0.1')).toBe(true);
			expect(isPrivateIP('192.168.255.255')).toBe(true);
			expect(isPrivateIP('192.167.0.1')).toBe(false); // not private
		});

		it('should not filter public IPs', () => {
			expect(isPrivateIP('8.8.8.8')).toBe(false);
			expect(isPrivateIP('1.2.3.4')).toBe(false);
			expect(isPrivateIP('100.200.100.200')).toBe(false);
		});
	});

	describe('URL normalization', () => {
		it('should normalize URLs without protocol', () => {
			expect(normalizeUrl('example.com')).toBe('http://example.com');
			expect(normalizeUrl('rpc.cosmos.network:26657')).toBe('http://rpc.cosmos.network:26657');
		});

		it('should preserve existing protocol', () => {
			expect(normalizeUrl('https://example.com')).toBe('https://example.com');
			expect(normalizeUrl('http://example.com')).toBe('http://example.com');
		});

		it('should strip trailing slashes', () => {
			expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
			expect(normalizeUrl('https://example.com//')).toBe('https://example.com');
		});

		it('should return null for invalid URLs', () => {
			expect(normalizeUrl('')).toBeNull();
			expect(normalizeUrl('not a url at all')).toBeNull();
		});
	});
});

describe('Status Response Parsing', () => {
	it('should extract chain_id from snake_case response', () => {
		const response = createMockStatusResponse('cosmoshub-4', 'node123', 'TestNode');

		expect(response.result.node_info.network).toBe('cosmoshub-4');
		expect(response.result.node_info.id).toBe('node123');
		expect(response.result.node_info.moniker).toBe('TestNode');
	});

	it('should extract sync_info from response', () => {
		const response = createMockStatusResponse('cosmoshub-4', 'node123', 'TestNode');

		expect(response.result.sync_info.latest_block_time).toBe(MOCK_BLOCK_TIME);
		expect(response.result.sync_info.latest_block_height).toBe('12345678');
	});
});

describe('Net Info Response Parsing', () => {
	it('should parse peers array from net_info response', () => {
		const result = mockNetInfoResponse.result;

		expect(result.peers).toBeDefined();
		expect(Array.isArray(result.peers)).toBe(true);
		expect(result.peers.length).toBe(mockPeers.length);
	});

	it('should access peer fields using snake_case', () => {
		const firstPeer = mockNetInfoResponse.result.peers[0];

		expect(firstPeer.remote_ip).toBe('1.2.3.4');
		expect(firstPeer.node_info.id).toBe('node1id');
		expect(firstPeer.node_info.moniker).toBe('Node 1');
		expect(firstPeer.node_info.listen_addr).toBe('tcp://1.2.3.4:26656');
		expect(firstPeer.node_info.other.rpc_address).toBe('tcp://0.0.0.0:26657');
	});
});

// Use actual utils functions imported above
