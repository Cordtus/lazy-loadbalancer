import { cacheManager, getCacheStats, sessionCache } from './cacheManager.ts';
import { CircuitBreaker } from './circuitBreaker.ts';
import config from './config.ts';
import dataService from './dataService.ts';
import { balancerLogger as logger } from './logger.ts';
// Load balancer using Bun's native fetch
import type { ChainEntry, EndpointStats, LbStrategy, RouteConfig } from './types.ts';

let chainsData: Record<string, ChainEntry> = {};

export async function initChainsData(): Promise<void> {
	chainsData = await dataService.loadChainsData();
}

export function getChainsData(): Record<string, ChainEntry> {
	return chainsData;
}

class LoadBalancer {
	// Test helpers (kept minimal and explicit)
	getEndpointsForTest(): EndpointStats[] {
		return this.endpoints;
	}

	setEndpointWeightForTest(index: number, weight: number): void {
		if (index < 0 || index >= this.endpoints.length) return;
		this.endpoints[index].weight = weight;
	}
	private endpoints: EndpointStats[];
	private currentIndex = 0;
	private strategy: LbStrategy;
	private routeConfig: RouteConfig | null;
	private activeConnections = new Map<string, number>();

	constructor(addresses: string[], strategy: LbStrategy, routeConfig: RouteConfig | null) {
		this.endpoints = addresses.map((address) => ({
			address,
			weight: 1,
			responseTime: 0,
			successCount: 0,
			failureCount: 0,
		}));
		this.strategy = strategy;
		this.routeConfig = routeConfig;
	}

	selectNextEndpoint(clientIp: string, chainName: string): string {
		let filtered = [...this.endpoints];

		// Apply whitelist/blacklist filters
		if (this.routeConfig?.filters) {
			const { whitelist, blacklist } = this.routeConfig.filters;

			if (whitelist?.length) {
				filtered = filtered.filter((e) => whitelist.some((p) => this.matchPattern(e.address, p)));
			}

			if (blacklist?.length) {
				filtered = filtered.filter((e) => !blacklist.some((p) => this.matchPattern(e.address, p)));
			}
		}

		if (filtered.length === 0) {
			filtered = this.endpoints;
			logger.warn('Filtered list empty, falling back to all endpoints');
		}

		// Sticky sessions
		if (this.routeConfig?.sticky) {
			const sessionKey = `${chainName}:${clientIp}`;
			const existing = sessionCache.get(sessionKey) as string | undefined;
			if (existing) {
				const found = filtered.find((e) => e.address === existing);
				if (found) return found.address;
			}
			const selected = this.selectByStrategy(filtered, clientIp);
			sessionCache.set(sessionKey, selected);
			return selected;
		}

		return this.selectByStrategy(filtered, clientIp);
	}

	private matchPattern(address: string, pattern: string): boolean {
		if (pattern.includes('*') || pattern.includes('?')) {
			const regex = new RegExp(
				`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`
			);
			return regex.test(address);
		}
		return address.includes(pattern);
	}

	private selectByStrategy(endpoints: EndpointStats[], clientIp: string): string {
		switch (this.strategy.type) {
			case 'round-robin':
				return this.roundRobin(endpoints);
			case 'weighted':
				return this.weighted(endpoints);
			case 'least-connections':
				return this.leastConnections(endpoints);
			case 'random':
				return this.random(endpoints);
			case 'ip-hash':
				return this.ipHash(endpoints, clientIp);
			default:
				return this.weighted(endpoints);
		}
	}

	private roundRobin(endpoints: EndpointStats[]): string {
		const selected = endpoints[this.currentIndex % endpoints.length];
		this.currentIndex = (this.currentIndex + 1) % endpoints.length;
		return selected.address;
	}

	private weighted(endpoints: EndpointStats[]): string {
		const totalWeight = endpoints.reduce((sum, e) => sum + e.weight, 0);
		let random = Math.random() * totalWeight;

		for (const endpoint of endpoints) {
			random -= endpoint.weight;
			if (random <= 0) return endpoint.address;
		}
		return endpoints[0].address;
	}

	private leastConnections(endpoints: EndpointStats[]): string {
		let min = Number.MAX_SAFE_INTEGER;
		let selected = endpoints[0];

		for (const endpoint of endpoints) {
			const conns = this.activeConnections.get(endpoint.address) || 0;
			if (conns < min) {
				min = conns;
				selected = endpoint;
			}
		}

		this.activeConnections.set(
			selected.address,
			(this.activeConnections.get(selected.address) || 0) + 1
		);
		return selected.address;
	}

	private random(endpoints: EndpointStats[]): string {
		return endpoints[Math.floor(Math.random() * endpoints.length)].address;
	}

	private ipHash(endpoints: EndpointStats[], clientIp: string): string {
		// Simple hash function
		let hash = 0;
		for (let i = 0; i < clientIp.length; i++) {
			hash = (hash << 5) - hash + clientIp.charCodeAt(i);
			hash |= 0;
		}
		return endpoints[Math.abs(hash) % endpoints.length].address;
	}

	updateStats(address: string, responseTime: number, success: boolean): void {
		const endpoint = this.endpoints.find((e) => e.address === address);
		if (!endpoint) return;

		// Weighted average for response time
		endpoint.responseTime =
			endpoint.responseTime === 0 ? responseTime : 0.8 * endpoint.responseTime + 0.2 * responseTime;

		if (success) {
			endpoint.successCount++;
		} else {
			endpoint.failureCount++;
		}

		// Update weight based on performance
		const successRate = endpoint.successCount / (endpoint.successCount + endpoint.failureCount + 1);
		const normalizedRt = Math.min(responseTime, 5000) / 5000;
		endpoint.weight = successRate * 0.7 + (1 - normalizedRt) * 0.3;

		// Decrement connection count for least-connections
		const conns = this.activeConnections.get(address) || 0;
		if (conns > 0) {
			this.activeConnections.set(address, conns - 1);
		}
	}

	getStats(): EndpointStats[] {
		return this.endpoints;
	}
}

const loadBalancers = new Map<string, Map<string, LoadBalancer>>();
const circuitBreakers = new Map<string, CircuitBreaker>();

export function selectNextRPC(chain: string, clientIp: string, path: string): string {
	const routeConfig = config.service.getEffectiveRouteConfig(chain, path);
	const routeKey = routeConfig.path;

	if (!loadBalancers.has(chain)) {
		loadBalancers.set(chain, new Map());
	}

	const chainBalancers = loadBalancers.get(chain)!;
	if (!chainBalancers.has(routeKey)) {
		chainBalancers.set(
			routeKey,
			new LoadBalancer(
				chainsData[chain]?.rpcAddresses || [],
				routeConfig.strategy || { type: 'weighted' },
				routeConfig
			)
		);
	}

	return chainBalancers.get(routeKey)!.selectNextEndpoint(clientIp, chain);
}

export async function proxyRequest(
	chain: string,
	path: string,
	method: string,
	headers: Headers,
	body: string | null,
	clientIp: string
): Promise<Response> {
	const routeConfig = config.service.getEffectiveRouteConfig(chain, path);
	const maxAttempts = routeConfig.retries || chainsData[chain]?.rpcAddresses?.length || 1;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const rpcAddress = selectNextRPC(chain, clientIp, path);
		const routeKey = routeConfig.path;
		const url = new URL(rpcAddress);
		url.pathname = url.pathname.replace(/\/?$/, '/') + path;

		if (!circuitBreakers.has(rpcAddress)) {
			circuitBreakers.set(rpcAddress, new CircuitBreaker());
		}

		const cb = circuitBreakers.get(rpcAddress)!;
		if (cb.isOpen()) {
			continue;
		}

		logger.debug(`Proxying to ${url.href} (attempt ${attempt + 1}/${maxAttempts})`);
		const startTime = performance.now();

		try {
			const reqHeaders = new Headers(headers);
			reqHeaders.set('host', url.host);
			reqHeaders.delete('content-length');

			const response = await fetch(url.href, {
				method,
				headers: reqHeaders,
				body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
				signal: AbortSignal.timeout(routeConfig.timeoutMs || config.requestTimeout),
			});

			const responseTime = performance.now() - startTime;
			logger.debug(`Response in ${responseTime.toFixed(0)}ms, status ${response.status}`);

			if (response.ok) {
				const text = await response.text();

				// Validate JSON
				try {
					JSON.parse(text);
				} catch {
					logger.error(`Invalid JSON from ${url.href}`);
					cb.recordFailure();
					loadBalancers.get(chain)?.get(routeKey)?.updateStats(rpcAddress, responseTime, false);
					continue;
				}

				cb.recordSuccess();
				loadBalancers.get(chain)?.get(routeKey)?.updateStats(rpcAddress, responseTime, true);

				// Return response without content-encoding/length headers
				const respHeaders = new Headers(response.headers);
				respHeaders.delete('content-encoding');
				respHeaders.delete('content-length');

				return new Response(text, {
					status: response.status,
					headers: respHeaders,
				});
			}

			logger.error(`Non-OK response from ${url.href}: ${response.status}`);
			cb.recordFailure();
			loadBalancers.get(chain)?.get(routeKey)?.updateStats(rpcAddress, responseTime, false);
		} catch (err) {
			const responseTime = performance.now() - startTime;
			logger.error(`Error proxying to ${url.href}`, err);
			cb.recordFailure();
			loadBalancers.get(chain)?.get(routeKey)?.updateStats(rpcAddress, responseTime, false);

			// Exponential backoff
			if (attempt < maxAttempts - 1) {
				const delay = Math.min(1000 * (routeConfig.backoffMultiplier || 1.5) ** attempt, 10000);
				await Bun.sleep(delay);
			}
		}
	}

	logger.error(`Failed after ${maxAttempts} attempts`);
	return new Response('Unable to process request after multiple attempts', { status: 502 });
}

export async function proxyWithCaching(
	chain: string,
	path: string,
	method: string,
	headers: Headers,
	body: string | null,
	clientIp: string
): Promise<Response> {
	const routeConfig = config.service.getEffectiveRouteConfig(chain, path);
	const cacheConfig = routeConfig.caching;

	const shouldCache =
		cacheConfig?.enabled &&
		(method === 'GET' ||
			(method === 'POST' &&
				body &&
				['block', 'tx', 'validators', 'status'].some((m) => body.includes(m))));

	const cacheKey = `${chain}:${method}:${path}:${body || ''}`;

	if (shouldCache) {
		const cached = cacheManager.get<string>(cacheKey);
		if (cached) {
			logger.debug(`Cache hit for ${cacheKey}`);
			return new Response(cached, {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		logger.debug(`Cache miss for ${cacheKey}`);
	}

	const response = await proxyRequest(chain, path, method, headers, body, clientIp);

	if (shouldCache && response.ok) {
		const text = await response.text();
		cacheManager.set(cacheKey, text, cacheConfig?.ttl);
		logger.debug(`Cached response for ${cacheKey}`);
		return new Response(text, {
			status: response.status,
			headers: response.headers,
		});
	}

	return response;
}

export function getStats(): Record<string, Record<string, EndpointStats[]>> {
	const stats: Record<string, Record<string, EndpointStats[]>> = {};

	for (const [chain, routeBalancers] of loadBalancers) {
		stats[chain] = {};
		for (const [routeKey, balancer] of routeBalancers) {
			stats[chain][routeKey] = balancer.getStats();
		}
	}

	return stats;
}

export function getChainStats(chain: string): Record<string, EndpointStats[]> | null {
	const chainBalancers = loadBalancers.get(chain);
	if (!chainBalancers) return null;

	const stats: Record<string, EndpointStats[]> = {};
	for (const [routeKey, balancer] of chainBalancers) {
		stats[routeKey] = balancer.getStats();
	}
	return stats;
}

export { LoadBalancer, getCacheStats };
