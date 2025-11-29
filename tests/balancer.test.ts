// tests/balancer.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadBalancer } from '../src/balancer';
import { CircuitBreaker } from '../src/circuitBreaker';

// Mock dependencies
vi.mock('../src/logger', () => ({
	balancerLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../src/circuitBreaker', () => ({
	CircuitBreaker: vi.fn().mockImplementation(() => ({
		isOpen: vi.fn().mockReturnValue(false),
		recordSuccess: vi.fn(),
		recordFailure: vi.fn(),
		getState: vi.fn().mockReturnValue('CLOSED'),
	})),
}));

describe('LoadBalancer', () => {
	const mockAddresses = [
		'https://rpc1.example.com',
		'https://rpc2.example.com',
		'https://rpc3.example.com',
	];

	let loadBalancer: LoadBalancer;

	beforeEach(() => {
		loadBalancer = new LoadBalancer(mockAddresses, { type: 'round-robin' }, null);
	});

	it('should initialize with provided addresses', () => {
		const endpoints = loadBalancer.getEndpointsForTest();
		expect(endpoints.length).toBe(3);
		expect(endpoints[0].address).toBe('https://rpc1.example.com');
		expect(endpoints[1].address).toBe('https://rpc2.example.com');
		expect(endpoints[2].address).toBe('https://rpc3.example.com');
	});

	describe('Round Robin Strategy', () => {
		it('should select endpoints in round-robin order', () => {
			const clientIp = '1.2.3.4';
			const chainName = 'testChain';

			const first = loadBalancer.selectNextEndpoint(clientIp, chainName);
			const second = loadBalancer.selectNextEndpoint(clientIp, chainName);
			const third = loadBalancer.selectNextEndpoint(clientIp, chainName);
			const fourth = loadBalancer.selectNextEndpoint(clientIp, chainName);

			expect(first).toBe('https://rpc1.example.com');
			expect(second).toBe('https://rpc2.example.com');
			expect(third).toBe('https://rpc3.example.com');
			expect(fourth).toBe('https://rpc1.example.com'); // Cycles back to first
		});
	});

	describe('Weighted Strategy', () => {
		beforeEach(() => {
			loadBalancer = new LoadBalancer(mockAddresses, { type: 'weighted' }, null);

			// Manipulate weights for testing using test helper
			loadBalancer.setEndpointWeightForTest(0, 1.0); // 50%
			loadBalancer.setEndpointWeightForTest(1, 0.5); // 25%
			loadBalancer.setEndpointWeightForTest(2, 0.5); // 25%
		});

		it('should select endpoints based on their weights', () => {
			// Mock random to ensure deterministic testing
			const mockRandom = vi.spyOn(Math, 'random');
			const clientIp = '1.2.3.4';
			const chainName = 'testChain';

			// Test first endpoint (weight 1.0)
			mockRandom.mockReturnValueOnce(0.4);
			expect(loadBalancer.selectNextEndpoint(clientIp, chainName)).toBe('https://rpc1.example.com');

			// Test second endpoint (weight 0.5)
			mockRandom.mockReturnValueOnce(0.6);
			expect(loadBalancer.selectNextEndpoint(clientIp, chainName)).toBe('https://rpc2.example.com');

			// Test third endpoint (weight 0.5)
			mockRandom.mockReturnValueOnce(0.8);
			expect(loadBalancer.selectNextEndpoint(clientIp, chainName)).toBe('https://rpc3.example.com');

			mockRandom.mockRestore();
		});
	});
	describe('Stats Tracking', () => {
		it('should update response time and success/failure counts', () => {
			// Initial state
			const endpoints = loadBalancer.getEndpointsForTest();
			expect(endpoints[0].responseTime).toBe(0);
			expect(endpoints[0].successCount).toBe(0);
			expect(endpoints[0].failureCount).toBe(0);

			// Record successful response
			loadBalancer.updateStats('https://rpc1.example.com', 100, true);
			expect(endpoints[0].responseTime).toBe(100);
			expect(endpoints[0].successCount).toBe(1);
			expect(endpoints[0].failureCount).toBe(0);

			// Record failure
			loadBalancer.updateStats('https://rpc1.example.com', 200, false);
			expect(endpoints[0].responseTime).toBe(120); // 0.8*100 + 0.2*200
			expect(endpoints[0].successCount).toBe(1);
			expect(endpoints[0].failureCount).toBe(1);
		});

		it('should adjust weights based on performance', () => {
			// Initial weight
			const endpoints = loadBalancer.getEndpointsForTest();
			expect(endpoints[0].weight).toBe(1);

			// Record multiple successful responses (high success rate, low latency)
			for (let i = 0; i < 10; i++) {
				loadBalancer.updateStats('https://rpc1.example.com', 50, true);
			}

			// Weight should be high due to good performance
			expect(endpoints[0].weight).toBeGreaterThan(0.8);

			// Record multiple failures (low success rate)
			for (let i = 0; i < 10; i++) {
				loadBalancer.updateStats('https://rpc1.example.com', 5000, false);
			}

			// Weight should be lower due to failures and high latency
			expect(endpoints[0].weight).toBeLessThan(0.5);
		});
	});

	describe('Filtering', () => {
		beforeEach(() => {
			loadBalancer = new LoadBalancer(
				[
					'https://rpc1.example.com',
					'https://rpc2.example.com',
					'https://backup.example.org',
					'https://test.other-domain.com',
				],
				{ type: 'round-robin' },
				{
					path: '/test',
					filters: {
						whitelist: ['*.example.com', 'backup.*'],
						blacklist: ['test.*'],
					},
				}
			);
		});

		it('should filter endpoints based on whitelist/blacklist', () => {
			const clientIp = '1.2.3.4';
			const chainName = 'testChain';

			// First call should select from filtered list (only example.com and backup domains)
			const first = loadBalancer.selectNextEndpoint(clientIp, chainName);
			const second = loadBalancer.selectNextEndpoint(clientIp, chainName);
			const third = loadBalancer.selectNextEndpoint(clientIp, chainName);

			// Should only ever return the first three endpoints (not test.other-domain.com)
			expect([
				'https://rpc1.example.com',
				'https://rpc2.example.com',
				'https://backup.example.org',
			]).toContain(first);
			expect([
				'https://rpc1.example.com',
				'https://rpc2.example.com',
				'https://backup.example.org',
			]).toContain(second);
			expect([
				'https://rpc1.example.com',
				'https://rpc2.example.com',
				'https://backup.example.org',
			]).toContain(third);

			// Should never select blacklisted endpoint
			expect(first).not.toBe('https://test.other-domain.com');
			expect(second).not.toBe('https://test.other-domain.com');
			expect(third).not.toBe('https://test.other-domain.com');
		});
	});
});
