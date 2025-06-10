// config.ts - Fixed naming inconsistency
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { appLogger as logger } from './logger.js';
import { LoadBalancerStrategy, ChainConfig, RouteConfig, GlobalConfig } from './types.js';
import { getDirName } from './utils.js';
import { URL, fileURLToPath } from 'url';

// Load environment variables
dotenv.config();


// Constants
export const REPO_OWNER = 'cosmos';
export const REPO_NAME = 'chain-registry';

// Timeouts and retry configuration
export const TIMEOUTS = {
  CRAWLER_REQUEST: 3000,
  BALANCER_REQUEST: 12000,
  CIRCUIT_BREAKER_RESET: 30000,
  DEFAULT_HTTP: 5000
} as const;

export const RETRY_CONFIG = {
  DEFAULT_RETRIES: 3,
  CRAWLER_RETRIES: 3,
  BACKOFF_MULTIPLIER: 1.5,
  CRAWLER_RETRY_DELAY: 1000
} as const;

export const CONCURRENCY_LIMITS = {
  CRAWLER_MAIN: 5,
  CRAWLER_PEERS: 10,
  CHAIN_CRAWLING: 3,
  API_REQUESTS: 10,
  DEFAULT: 5
} as const;

export const CACHE_CONFIG = {
  DEFAULT_TTL: 60,
  CHAIN_LIST_TTL: 300,
  TRANSACTION_TTL: 3600,
  BLOCK_TTL: 3600,
  STATUS_TTL: 60,
  VALIDATORS_TTL: 300,
  SESSION_TTL: 300,
  PERSISTENT_TTL: 3600,
  MEMORY_CLEANUP_THRESHOLD: 100 * 1024 * 1024 // 100MB
} as const;

// Directory paths
const PROJECT_ROOT = path.resolve(getDirName(import.meta.url), '../..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const GLOBAL_CONFIG_PATH = path.join(CONFIG_DIR, 'global.json');
const CHAIN_CONFIG_DIR = path.join(CONFIG_DIR, 'chains');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// Default static configuration parameters
export const staticConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || TIMEOUTS.BALANCER_REQUEST.toString(), 10),
  github: {
    pat: process.env.GITHUB_PAT,
    owner: REPO_OWNER,
    repo: REPO_NAME,
  },
  chains: {
    checkInterval: 24 * 60 * 60 * 1000, // 24h in ms
  },
  crawler: {
    timeout: parseInt(process.env.CRAWLER_TIMEOUT || TIMEOUTS.CRAWLER_REQUEST.toString(), 10),
    retries: parseInt(process.env.CRAWLER_RETRIES || RETRY_CONFIG.CRAWLER_RETRIES.toString(), 10),
    retryDelay: parseInt(process.env.CRAWLER_RETRY_DELAY || RETRY_CONFIG.CRAWLER_RETRY_DELAY.toString(), 10),
    maxDepth: parseInt(process.env.CRAWLER_MAX_DEPTH || '3', 10),
    recheckInterval: 24 * 60 * 60 * 1000, // 24h
  },
  logging: {
    balancer: process.env.LOG_LEVEL_BALANCER || 'info',
    crawler: process.env.LOG_LEVEL_CRAWLER || 'info',
    app: process.env.LOG_LEVEL_APP || 'info',
  },
};

// Default global configuration
const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  defaultStrategy: {
    type: 'weighted',
  },
  defaultTimeoutMs: TIMEOUTS.DEFAULT_HTTP,
  defaultRetries: RETRY_CONFIG.DEFAULT_RETRIES,
  defaultBackoffMultiplier: RETRY_CONFIG.BACKOFF_MULTIPLIER,
  defaultCaching: {
    enabled: true,
    ttl: 60, // 60 seconds
  },
  chains: {},
};

// Config service class
class ConfigService {
  private globalConfig: GlobalConfig;
  private chainConfigs: Record<string, ChainConfig> = {};
  private configWatchers: Map<string, fs.FSWatcher> = new Map();

  constructor() {
    this.ensureConfigDirectories();
    this.globalConfig = this.loadGlobalConfig();
    this.loadAllChainConfigs();
    this.setupConfigWatchers();
  }

  private ensureConfigDirectories(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (!fs.existsSync(CHAIN_CONFIG_DIR)) {
      fs.mkdirSync(CHAIN_CONFIG_DIR, { recursive: true });
    }
    if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
      fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(DEFAULT_GLOBAL_CONFIG, null, 2));
    }
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private loadGlobalConfig(): GlobalConfig {
    try {
      const data = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');
      const parsedConfig = JSON.parse(data) as GlobalConfig;
      return {
        ...DEFAULT_GLOBAL_CONFIG, // Include defaults for any missing fields
        ...parsedConfig, // Override with values from file
      };
    } catch (error) {
      logger.error('Error loading global config, using defaults:', error);
      return DEFAULT_GLOBAL_CONFIG;
    }
  }

  private loadChainConfig(chainName: string): ChainConfig | null {
    const configPath = path.join(CHAIN_CONFIG_DIR, `${chainName}.json`);
    if (!fs.existsSync(configPath)) {
      return null;
    }

    try {
      const data = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(data) as ChainConfig;
      return config;
    } catch (error) {
      logger.error(`Error loading config for chain ${chainName}:`, error);
      return null;
    }
  }

  private loadAllChainConfigs(): void {
    if (!fs.existsSync(CHAIN_CONFIG_DIR)) return;

    try {
      const files = fs.readdirSync(CHAIN_CONFIG_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const chainName = file.replace('.json', '');
          const config = this.loadChainConfig(chainName);
          if (config) {
            this.chainConfigs[chainName] = config;
          }
        }
      }
    } catch (error) {
      logger.error('Error loading chain configs:', error);
    }
  }

  private setupConfigWatchers(): void {
    if (process.env.NODE_ENV === 'production') {
      logger.info('Config watchers disabled in production mode');
      return;
    }

    // Watch global config
    if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
      this.configWatchers.set(
        'global',
        fs.watch(GLOBAL_CONFIG_PATH, () => {
          logger.info('Global config changed, reloading...');
          this.globalConfig = this.loadGlobalConfig();
        })
      );
    }

    // Watch chain config directory
    if (fs.existsSync(CHAIN_CONFIG_DIR)) {
      this.configWatchers.set(
        'chains',
        fs.watch(CHAIN_CONFIG_DIR, (eventType, filename) => {
          if (filename && filename.endsWith('.json')) {
            const chainName = filename.replace('.json', '');
            logger.info(`Config for chain ${chainName} changed, reloading...`);
            const config = this.loadChainConfig(chainName);
            if (config) {
              this.chainConfigs[chainName] = config;
            } else {
              delete this.chainConfigs[chainName];
            }
          }
        })
      );
    }
  }

  public getGlobalConfig(): GlobalConfig {
    return this.globalConfig;
  }

  public saveGlobalConfig(config: GlobalConfig): void {
    this.ensureConfigDirectories();
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
    this.globalConfig = config;
  }

  public getChainConfig(chainName: string): ChainConfig | null {
    // Check if we have a specific config for this chain
    if (this.chainConfigs[chainName]) {
      return this.chainConfigs[chainName];
    }

    // Check if the chain is defined in the global config
    if (this.globalConfig.chains && this.globalConfig.chains[chainName]) {
      return this.globalConfig.chains[chainName];
    }

    return null;
  }

  public createDefaultChainConfig(chainName: string): ChainConfig {
    return {
      defaultStrategy: this.globalConfig.defaultStrategy,
      defaultTimeoutMs: this.globalConfig.defaultTimeoutMs,
      defaultRetries: this.globalConfig.defaultRetries,
      defaultBackoffMultiplier: this.globalConfig.defaultBackoffMultiplier,
      defaultCaching: { ...this.globalConfig.defaultCaching },
      routes: [],
    };
  }

  public saveChainConfig(chainName: string, config: ChainConfig): void {
    this.ensureConfigDirectories();
    const configPath = path.join(CHAIN_CONFIG_DIR, `${chainName}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    this.chainConfigs[chainName] = config;
  }

  public getRouteConfig(chainName: string, path: string): RouteConfig | null {
    const chainConfig = this.getChainConfig(chainName);
    if (!chainConfig || !chainConfig.routes) return null;

    // Look for an exact path match first
    const exactMatch = chainConfig.routes.find((route) => route.path === path);
    if (exactMatch) return exactMatch;

    // If no exact match, look for a pattern match
    for (const route of chainConfig.routes) {
      if (this.pathMatchesPattern(path, route.path)) {
        return route;
      }
    }

    return null;
  }

  private pathMatchesPattern(path: string, pattern: string): boolean {
    // Convert pattern to regex
    const regexPattern = pattern
      .replace(/\*/g, '.*') // * becomes .*
      .replace(/\?/g, '.'); // ? becomes .

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(path);
  }

  public getEffectiveRouteConfig(chainName: string, path: string): RouteConfig {
    const chainConfig = this.getChainConfig(chainName);
    const routeConfig = this.getRouteConfig(chainName, path);

    // Create a default route config based on chain defaults or global defaults
    const defaultRouteConfig: RouteConfig = {
      path,
      strategy: chainConfig?.defaultStrategy || this.globalConfig.defaultStrategy,
      timeoutMs: chainConfig?.defaultTimeoutMs || this.globalConfig.defaultTimeoutMs,
      retries: chainConfig?.defaultRetries || this.globalConfig.defaultRetries,
      backoffMultiplier:
        chainConfig?.defaultBackoffMultiplier || this.globalConfig.defaultBackoffMultiplier,
      caching: chainConfig?.defaultCaching || this.globalConfig.defaultCaching,
      sticky: chainConfig?.defaultSticky || false,
      filters: chainConfig?.defaultFilters || undefined,
    };

    // If no specific route config, return the default
    if (!routeConfig) {
      return defaultRouteConfig;
    }

    // Merge the route config with the default route config
    return {
      ...defaultRouteConfig,
      ...routeConfig,
    };
  }

  // Cleanup watchers
  public cleanup(): void {
    for (const watcher of this.configWatchers.values()) {
      watcher.close();
    }
    this.configWatchers.clear();
  }
}

// Create a singleton instance
const configService = new ConfigService();

// Log config loaded message
logger.info('Configuration loaded');

// Export static config and config service
const config = {
  ...staticConfig,
  service: configService,
};

export default config;
