import { CACHE_TTL } from './config.ts';
// Lightweight cache manager using native Map
import { appLogger as logger } from './logger.ts';

interface CacheEntry<T> {
	value: T;
	expiry: number;
}

class Cache<T = unknown> {
	private store = new Map<string, CacheEntry<T>>();
	private defaultTtl: number;
	private hits = 0;
	private misses = 0;

	constructor(defaultTtl = 60) {
		this.defaultTtl = defaultTtl * 1000; // Convert to ms
	}

	get(key: string): T | undefined {
		const entry = this.store.get(key);
		if (!entry) {
			this.misses++;
			return undefined;
		}
		if (Date.now() > entry.expiry) {
			this.store.delete(key);
			this.misses++;
			return undefined;
		}
		this.hits++;
		return entry.value;
	}

	set(key: string, value: T, ttlSeconds?: number): void {
		const ttl = ttlSeconds ? ttlSeconds * 1000 : this.defaultTtl;
		this.store.set(key, {
			value,
			expiry: Date.now() + ttl,
		});
	}

	delete(key: string): boolean {
		return this.store.delete(key);
	}

	has(key: string): boolean {
		const entry = this.store.get(key);
		if (!entry) return false;
		if (Date.now() > entry.expiry) {
			this.store.delete(key);
			return false;
		}
		return true;
	}

	clear(): void {
		this.store.clear();
	}

	size(): number {
		return this.store.size;
	}

	keys(): string[] {
		return Array.from(this.store.keys());
	}

	prune(): number {
		const now = Date.now();
		let pruned = 0;
		for (const [key, entry] of this.store) {
			if (now > entry.expiry) {
				this.store.delete(key);
				pruned++;
			}
		}
		return pruned;
	}

	getStats() {
		return {
			keys: this.store.size,
			hits: this.hits,
			misses: this.misses,
			hitRate: this.hits + this.misses > 0 ? (this.hits / (this.hits + this.misses)) * 100 : 0,
		};
	}
}

// Cache instances
export const mainCache = new Cache(CACHE_TTL.DEFAULT);
export const persistentCache = new Cache(CACHE_TTL.PERSISTENT);
export const sessionCache = new Cache(CACHE_TTL.SESSION);
export const metricsCache = new Cache(CACHE_TTL.STATUS);

// Cache patterns for auto TTL selection
const cachePatterns: Array<{ pattern: RegExp; ttl: number; cache: Cache }> = [
	{ pattern: /^chain:list/, ttl: CACHE_TTL.CHAIN_LIST, cache: mainCache },
	{ pattern: /^chain:summary/, ttl: CACHE_TTL.CHAIN_LIST, cache: mainCache },
	{ pattern: /^rpc:list/, ttl: CACHE_TTL.CHAIN_LIST, cache: mainCache },
	{ pattern: /^tx:/, ttl: CACHE_TTL.TRANSACTION, cache: mainCache },
	{ pattern: /^block:\d+$/, ttl: CACHE_TTL.BLOCK, cache: mainCache },
	{ pattern: /^validators/, ttl: CACHE_TTL.VALIDATORS, cache: mainCache },
	{ pattern: /^status/, ttl: CACHE_TTL.STATUS, cache: mainCache },
	{ pattern: /^metrics/, ttl: CACHE_TTL.STATUS, cache: metricsCache },
];

function selectCacheAndTtl(key: string): { cache: Cache; ttl: number } {
	for (const { pattern, ttl, cache } of cachePatterns) {
		if (pattern.test(key)) {
			return { cache, ttl };
		}
	}
	return { cache: mainCache, ttl: CACHE_TTL.DEFAULT };
}

export function setCacheItem<T>(key: string, value: T, ttl?: number): void {
	const { cache, ttl: defaultTtl } = selectCacheAndTtl(key);
	cache.set(key, value, ttl ?? defaultTtl);
	logger.debug(`Cached item ${key} with TTL ${ttl ?? defaultTtl}s`);
}

export function getCacheItem<T>(key: string): T | undefined {
	// Check all caches
	for (const cache of [mainCache, persistentCache, sessionCache, metricsCache]) {
		const result = cache.get(key) as T | undefined;
		if (result !== undefined) return result;
	}
	return undefined;
}

export function deleteCacheItem(key: string): void {
	for (const cache of [mainCache, persistentCache, sessionCache, metricsCache]) {
		cache.delete(key);
	}
	logger.debug(`Deleted cache item ${key}`);
}

export function flushCache(pattern?: string): number {
	let deleted = 0;

	if (pattern) {
		const regex = new RegExp(pattern);
		for (const cache of [mainCache, persistentCache, sessionCache, metricsCache]) {
			for (const key of cache.keys()) {
				if (regex.test(key)) {
					cache.delete(key);
					deleted++;
				}
			}
		}
	} else {
		for (const cache of [mainCache, persistentCache, sessionCache, metricsCache]) {
			deleted += cache.size();
			cache.clear();
		}
	}

	logger.info(`Flushed ${deleted} items from cache${pattern ? ` matching ${pattern}` : ''}`);
	return deleted;
}

export function getCacheStats() {
	return {
		main: mainCache.getStats(),
		persistent: persistentCache.getStats(),
		session: sessionCache.getStats(),
		metrics: metricsCache.getStats(),
	};
}

// Periodic cleanup
setInterval(() => {
	let pruned = 0;
	for (const cache of [mainCache, persistentCache, sessionCache, metricsCache]) {
		pruned += cache.prune();
	}
	if (pruned > 0) {
		logger.debug(`Pruned ${pruned} expired cache entries`);
	}
}, 60000);

// Unified cache manager API
export const cacheManager = {
	set: setCacheItem,
	get: getCacheItem,
	delete: deleteCacheItem,
	flush: flushCache,
	stats: getCacheStats,
};

export default cacheManager;
