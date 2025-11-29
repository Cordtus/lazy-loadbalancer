// Configuration using Bun's native APIs
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { appLogger as logger } from './logger.ts';
import type { ChainConfig, GlobalConfig, RouteConfig } from './types.ts';

// Constants
export const REPO_OWNER = 'cosmos';
export const REPO_NAME = 'chain-registry';

export const TIMEOUTS = {
	CRAWLER_REQUEST: 3000,
	BALANCER_REQUEST: 12000,
	CIRCUIT_BREAKER_RESET: 30000,
	DEFAULT_HTTP: 5000,
} as const;

export const RETRY_CONFIG = {
	DEFAULT_RETRIES: 3,
	CRAWLER_RETRIES: 3,
	BACKOFF_MULTIPLIER: 1.5,
	CRAWLER_RETRY_DELAY: 1000,
} as const;

export const CONCURRENCY = {
	CRAWLER_MAIN: 5,
	CRAWLER_PEERS: 10,
	CHAIN_CRAWLING: 3,
	API_REQUESTS: 10,
} as const;

export const CACHE_TTL = {
	DEFAULT: 60,
	CHAIN_LIST: 300,
	TRANSACTION: 3600,
	BLOCK: 3600,
	STATUS: 60,
	VALIDATORS: 300,
	SESSION: 300,
	PERSISTENT: 3600,
} as const;

// Directory paths
const PROJECT_ROOT = process.cwd();
const CONFIG_DIR = join(PROJECT_ROOT, 'config');
const GLOBAL_CONFIG_PATH = join(CONFIG_DIR, 'global.json');
const CHAIN_CONFIG_DIR = join(CONFIG_DIR, 'chains');
const DATA_DIR = join(PROJECT_ROOT, 'data');

// Default global config
const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
	defaultStrategy: { type: 'weighted' },
	defaultTimeoutMs: TIMEOUTS.DEFAULT_HTTP,
	defaultRetries: RETRY_CONFIG.DEFAULT_RETRIES,
	defaultBackoffMultiplier: RETRY_CONFIG.BACKOFF_MULTIPLIER,
	defaultCaching: { enabled: true, ttl: 60 },
	chains: {},
};

class ConfigService {
	private globalConfig: GlobalConfig;
	private chainConfigs: Map<string, ChainConfig> = new Map();
	private watchers: Array<ReturnType<typeof watch>> = [];

	constructor() {
		this.ensureDirs();
		this.globalConfig = this.loadGlobalConfig();
		this.loadAllChainConfigs();
		if (process.env.NODE_ENV !== 'production') {
			this.setupWatchers();
		}
	}

	private ensureDirs(): void {
		for (const dir of [CONFIG_DIR, CHAIN_CONFIG_DIR, DATA_DIR]) {
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
		}
		if (!existsSync(GLOBAL_CONFIG_PATH)) {
			Bun.write(GLOBAL_CONFIG_PATH, JSON.stringify(DEFAULT_GLOBAL_CONFIG, null, 2));
		}
	}

	private loadGlobalConfig(): GlobalConfig {
		try {
			if (!existsSync(GLOBAL_CONFIG_PATH)) return DEFAULT_GLOBAL_CONFIG;
			const content = readFileSync(GLOBAL_CONFIG_PATH, 'utf-8');
			if (!content) return DEFAULT_GLOBAL_CONFIG;
			const data = JSON.parse(content);
			return { ...DEFAULT_GLOBAL_CONFIG, ...data };
		} catch (err) {
			logger.error('Failed to load global config, using defaults', err);
			return DEFAULT_GLOBAL_CONFIG;
		}
	}

	private loadChainConfig(chainName: string): ChainConfig | null {
		const configPath = join(CHAIN_CONFIG_DIR, `${chainName}.json`);
		if (!existsSync(configPath)) return null;
		try {
			const content = readFileSync(configPath, 'utf-8');
			return JSON.parse(content);
		} catch (err) {
			logger.error(`Failed to load config for chain ${chainName}`, err);
			return null;
		}
	}

	private loadAllChainConfigs(): void {
		if (!existsSync(CHAIN_CONFIG_DIR)) return;
		try {
			const files = Array.from(new Bun.Glob('*.json').scanSync(CHAIN_CONFIG_DIR));
			for (const file of files) {
				const chainName = file.replace('.json', '');
				const cfg = this.loadChainConfig(chainName);
				if (cfg) this.chainConfigs.set(chainName, cfg);
			}
		} catch (err) {
			logger.error('Failed to load chain configs', err);
		}
	}

	private setupWatchers(): void {
		if (existsSync(GLOBAL_CONFIG_PATH)) {
			this.watchers.push(
				watch(GLOBAL_CONFIG_PATH, () => {
					logger.info('Global config changed, reloading...');
					this.globalConfig = this.loadGlobalConfig();
				})
			);
		}
		if (existsSync(CHAIN_CONFIG_DIR)) {
			this.watchers.push(
				watch(CHAIN_CONFIG_DIR, (_event, filename) => {
					if (filename?.endsWith('.json')) {
						const name = filename.replace('.json', '');
						logger.info(`Config for chain ${name} changed, reloading...`);
						const cfg = this.loadChainConfig(name);
						if (cfg) {
							this.chainConfigs.set(name, cfg);
						} else {
							this.chainConfigs.delete(name);
						}
					}
				})
			);
		}
	}

	getGlobalConfig(): GlobalConfig {
		return this.globalConfig;
	}

	saveGlobalConfig(config: GlobalConfig): void {
		Bun.write(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
		this.globalConfig = config;
	}

	getChainConfig(chainName: string): ChainConfig | null {
		return this.chainConfigs.get(chainName) || this.globalConfig.chains[chainName] || null;
	}

	createDefaultChainConfig(_chainName: string): ChainConfig {
		return {
			defaultStrategy: this.globalConfig.defaultStrategy,
			defaultTimeoutMs: this.globalConfig.defaultTimeoutMs,
			defaultRetries: this.globalConfig.defaultRetries,
			defaultBackoffMultiplier: this.globalConfig.defaultBackoffMultiplier,
			defaultCaching: { ...this.globalConfig.defaultCaching },
			routes: [],
		};
	}

	saveChainConfig(chainName: string, config: ChainConfig): void {
		const configPath = join(CHAIN_CONFIG_DIR, `${chainName}.json`);
		Bun.write(configPath, JSON.stringify(config, null, 2));
		this.chainConfigs.set(chainName, config);
	}

	getRouteConfig(chainName: string, path: string): RouteConfig | null {
		const chainConfig = this.getChainConfig(chainName);
		if (!chainConfig?.routes) return null;

		// Exact match first
		const exactMatch = chainConfig.routes.find((r) => r.path === path);
		if (exactMatch) return exactMatch;

		// Pattern match
		for (const route of chainConfig.routes) {
			if (this.pathMatchesPattern(path, route.path)) {
				return route;
			}
		}
		return null;
	}

	private pathMatchesPattern(path: string, pattern: string): boolean {
		const regex = new RegExp(`^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
		return regex.test(path);
	}

	getEffectiveRouteConfig(chainName: string, path: string): RouteConfig {
		const chainConfig = this.getChainConfig(chainName);
		const routeConfig = this.getRouteConfig(chainName, path);

		const defaultRoute: RouteConfig = {
			path,
			strategy: chainConfig?.defaultStrategy || this.globalConfig.defaultStrategy,
			timeoutMs: chainConfig?.defaultTimeoutMs || this.globalConfig.defaultTimeoutMs,
			retries: chainConfig?.defaultRetries || this.globalConfig.defaultRetries,
			backoffMultiplier:
				chainConfig?.defaultBackoffMultiplier || this.globalConfig.defaultBackoffMultiplier,
			caching: chainConfig?.defaultCaching || this.globalConfig.defaultCaching,
			sticky: chainConfig?.defaultSticky || false,
			filters: chainConfig?.defaultFilters,
		};

		return routeConfig ? { ...defaultRoute, ...routeConfig } : defaultRoute;
	}

	cleanup(): void {
		for (const watcher of this.watchers) {
			watcher.close();
		}
		this.watchers = [];
	}
}

// Singleton
const configService = new ConfigService();

// Static config from env
export const staticConfig = {
	port: Number(process.env.PORT) || 3000,
	requestTimeout: Number(process.env.REQUEST_TIMEOUT) || TIMEOUTS.BALANCER_REQUEST,
	github: {
		pat: process.env.GITHUB_PAT,
		owner: REPO_OWNER,
		repo: REPO_NAME,
	},
	crawler: {
		timeout: Number(process.env.CRAWLER_TIMEOUT) || TIMEOUTS.CRAWLER_REQUEST,
		retries: Number(process.env.CRAWLER_RETRIES) || RETRY_CONFIG.CRAWLER_RETRIES,
		retryDelay: Number(process.env.CRAWLER_RETRY_DELAY) || RETRY_CONFIG.CRAWLER_RETRY_DELAY,
		maxDepth: Number(process.env.CRAWLER_MAX_DEPTH) || 3,
	},
};

const config = {
	...staticConfig,
	service: configService,
};

export default config;
