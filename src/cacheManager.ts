import { CACHE_TTL } from './config.ts';
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
		if (!entry || Date.now() > entry.expiry) {
			if (entry) this.store.delete(key);
			this.misses++;
			return undefined;
		}
		this.hits++;
		return entry.value;
	}

	set(key: string, value: T, ttlSeconds?: number): void {
		this.store.set(key, {
			value,
			expiry: Date.now() + (ttlSeconds ? ttlSeconds * 1000 : this.defaultTtl),
		});
	}

	delete(key: string): boolean {
		return this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
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

export const mainCache = new Cache(CACHE_TTL.DEFAULT);

export function flushCache(pattern?: string): number {
	let deleted = 0;

	if (pattern) {
		const regex = new RegExp(pattern);
		for (const key of mainCache.keys()) {
			if (regex.test(key)) {
				mainCache.delete(key);
				deleted++;
			}
		}
	} else {
		const keys = mainCache.keys();
		deleted = keys.length;
		mainCache.clear();
	}

	logger.info(`Flushed ${deleted} items from cache${pattern ? ` matching ${pattern}` : ''}`);
	return deleted;
}

export function getCacheStats() {
	return mainCache.getStats();
}

setInterval(() => {
	const pruned = mainCache.prune();
	if (pruned > 0) {
		logger.debug(`Pruned ${pruned} expired cache entries`);
	}
}, 60000);

export const cacheManager = {
	get: <T>(key: string): T | undefined => mainCache.get(key) as T | undefined,
	set: <T>(key: string, value: T, ttl?: number): void => mainCache.set(key, value, ttl),
	flush: flushCache,
	stats: getCacheStats,
};

export default cacheManager;
