// cacheManager.ts
import NodeCache from 'node-cache';
import { appLogger as logger } from './logger.js';
import { CACHE_CONFIG } from './config.js';

// Main cache for API responses
export const cache = new NodeCache({
  stdTTL: 60, // Default TTL: 60 seconds
  checkperiod: 120, // Check for expired keys every 120 seconds
  useClones: false, // Performance optimization - disable cloning
  deleteOnExpire: true, // Auto-delete expired items
});

// Secondary cache for longer-lived data (configurations, etc.)
export const persistentCache = new NodeCache({
  stdTTL: 3600, // Default TTL: 1 hour
  checkperiod: 600, // Check for expired keys every 10 minutes
  useClones: false,
});

// Session cache for sticky sessions
export const sessionCache = new NodeCache({
  stdTTL: 300, // Default TTL: 5 minutes
  checkperiod: 60, // Check for expired keys every minute
  useClones: false,
});

// Metrics cache
export const metricsCache = new NodeCache({
  stdTTL: 60, // Default TTL: 60 seconds
  checkperiod: 30, // Check for expired keys every 30 seconds
  useClones: false,
});

// Configurable cache options by key pattern
const cacheConfigs: Array<{
  pattern: RegExp;
  ttl: number;
  type: 'main' | 'persistent' | 'session' | 'metrics';
}> = [
  { pattern: /^chain:list/, ttl: 300, type: 'main' }, // Chain listings: 5 minutes
  { pattern: /^chain:summary/, ttl: 300, type: 'main' }, // Chain summaries: 5 minutes
  { pattern: /^rpc:list/, ttl: 300, type: 'main' }, // RPC listings: 5 minutes
  { pattern: /^tx:/, ttl: 3600, type: 'main' }, // Transactions: 1 hour (immutable)
  { pattern: /^block:[0-9]+$/, ttl: 3600, type: 'main' }, // Specific blocks by height: 1 hour (immutable)
  { pattern: /^validators/, ttl: 300, type: 'main' }, // Validators: 5 minutes
  { pattern: /^status/, ttl: 60, type: 'main' }, // Status: 1 minute
  { pattern: /^metrics/, ttl: 60, type: 'metrics' }, // Metrics: 1 minute
];

// Cache management functions
export function setCacheItem(key: string, value: any, ttl?: number): void {
  // Determine the appropriate cache and TTL based on key pattern
  const config = cacheConfigs.find((cfg) => cfg.pattern.test(key));
  const selectedTtl = ttl || (config ? config.ttl : 60); // Default to 60s if no match

  let targetCache = cache; // Default to main cache

  if (config) {
    switch (config.type) {
      case 'persistent':
        targetCache = persistentCache;
        break;
      case 'session':
        targetCache = sessionCache;
        break;
      case 'metrics':
        targetCache = metricsCache;
        break;
    }
  }

  targetCache.set(key, value, selectedTtl);
  logger.debug(`Cached item ${key} with TTL ${selectedTtl}s`);
}

export function getCacheItem<T>(key: string): T | undefined {
  // Try all caches in appropriate order
  let result: T | undefined;

  result = cache.get<T>(key);
  if (result !== undefined) return result;

  result = persistentCache.get<T>(key);
  if (result !== undefined) return result;

  result = sessionCache.get<T>(key);
  if (result !== undefined) return result;

  result = metricsCache.get<T>(key);
  return result;
}

export function deleteCacheItem(key: string): void {
  cache.del(key);
  persistentCache.del(key);
  sessionCache.del(key);
  metricsCache.del(key);
  logger.debug(`Deleted cache item ${key} from all caches`);
}

export function flushCache(pattern?: string): number {
  let deletedCount = 0;

  if (pattern) {
    const regex = new RegExp(pattern);

    // Delete matching keys from all caches
    [cache, persistentCache, sessionCache, metricsCache].forEach((cacheInstance) => {
      const keys = cacheInstance.keys().filter((key) => regex.test(key));
      keys.forEach((key) => cacheInstance.del(key));
      deletedCount += keys.length;
    });
  } else {
    // Flush all caches completely
    deletedCount += cache.keys().length;
    deletedCount += persistentCache.keys().length;
    deletedCount += sessionCache.keys().length;
    deletedCount += metricsCache.keys().length;

    cache.flushAll();
    persistentCache.flushAll();
    sessionCache.flushAll();
    metricsCache.flushAll();
  }

  logger.info(
    `Flushed ${deletedCount} items from cache${pattern ? ` matching pattern ${pattern}` : ''}`
  );
  return deletedCount;
}

// Cache statistics
export function getCacheStats() {
  return {
    main: {
      keys: cache.keys().length,
      hits: cache.getStats().hits,
      misses: cache.getStats().misses,
      ksize: cache.getStats().ksize,
      vsize: cache.getStats().vsize,
    },
    persistent: {
      keys: persistentCache.keys().length,
      hits: persistentCache.getStats().hits,
      misses: persistentCache.getStats().misses,
      ksize: persistentCache.getStats().ksize,
      vsize: persistentCache.getStats().vsize,
    },
    session: {
      keys: sessionCache.keys().length,
      hits: sessionCache.getStats().hits,
      misses: sessionCache.getStats().misses,
      ksize: sessionCache.getStats().ksize,
      vsize: sessionCache.getStats().vsize,
    },
    metrics: {
      keys: metricsCache.keys().length,
      hits: metricsCache.getStats().hits,
      misses: metricsCache.getStats().misses,
      ksize: metricsCache.getStats().ksize,
      vsize: metricsCache.getStats().vsize,
    },
  };
}

// Monitor cache size and performance
setInterval(() => {
  const stats = getCacheStats();
  const totalKeys =
    stats.main.keys + stats.persistent.keys + stats.session.keys + stats.metrics.keys;

  const totalMemoryKB =
    (stats.main.ksize +
      stats.main.vsize +
      stats.persistent.ksize +
      stats.persistent.vsize +
      stats.session.ksize +
      stats.session.vsize +
      stats.metrics.ksize +
      stats.metrics.vsize) /
    1024;

  logger.debug(`Cache stats: ${totalKeys} total keys, ~${totalMemoryKB.toFixed(2)}KB memory usage`);

  // If memory usage gets too high, prune some caches
  if (totalMemoryKB > CACHE_CONFIG.MEMORY_CLEANUP_THRESHOLD / 1024) {
    // Memory cleanup threshold
    logger.warn(`Cache memory usage high (${totalMemoryKB.toFixed(2)}KB), pruning oldest items`);
    // Prune main cache by removing 20% of oldest items
    const mainKeys = cache.keys();
    const toRemove = Math.floor(mainKeys.length * 0.2);
    if (toRemove > 0) {
      // Get TTLs and sort keys by expiration (oldest first)
      const keysByAge = mainKeys
        .map((key) => ({ key, ttl: cache.getTtl(key) || Date.now() }))
        .sort((a, b) => a.ttl - b.ttl)
        .slice(0, toRemove);

      keysByAge.forEach((item) => cache.del(item.key));
      logger.info(`Pruned ${toRemove} items from main cache to free memory`);
    }
  }
}, 60000); // Check every minute

// API for cache management
export const cacheManager = {
  set: setCacheItem,
  get: getCacheItem,
  delete: deleteCacheItem,
  flush: flushCache,
  stats: getCacheStats,
};

export default cacheManager;
