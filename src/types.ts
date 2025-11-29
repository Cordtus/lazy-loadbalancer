// Types for Cosmos SDK RPC load balancer

export interface ChainEntry {
	chainName: string;
	chainId: string;
	bech32Prefix: string;
	rpcAddresses: string[];
	timeout?: string;
	timestamp?: number;
	lastUpdated?: string;
	lastCrawled?: string;
}

export interface NetInfo {
	peers: Peer[];
}

export interface Peer {
	remote_ip: string;
	node_info: {
		id: string;
		moniker: string;
		listen_addr: string;
		other: {
			rpc_address: string;
		};
	};
}

export interface StatusResponse {
	result: {
		node_info: {
			id?: string;
			moniker?: string;
			network: string;
			other?: {
				tx_index?: string;
			};
		};
		sync_info: {
			latest_block_time: string;
			latest_block_height: string;
		};
	};
}

export interface BlacklistedIP {
	ip: string;
	failureCount: number;
	timestamp: number;
}

export interface EndpointStats {
	address: string;
	weight: number;
	responseTime: number;
	successCount: number;
	failureCount: number;
	lastSeen?: number;
}

export type LbStrategyType =
	| 'round-robin'
	| 'weighted'
	| 'least-connections'
	| 'random'
	| 'ip-hash';

export interface LbStrategy {
	type: LbStrategyType;
	options?: Record<string, unknown>;
}

export interface EndpointFilters {
	whitelist?: string[];
	blacklist?: string[];
}

export interface RouteConfig {
	path: string;
	strategy?: LbStrategy;
	filters?: EndpointFilters;
	caching?: {
		enabled: boolean;
		ttl: number;
	};
	sticky?: boolean;
	timeoutMs?: number;
	retries?: number;
	backoffMultiplier?: number;
}

export interface ChainConfig {
	defaultStrategy: LbStrategy;
	defaultFilters?: EndpointFilters;
	defaultCaching?: {
		enabled: boolean;
		ttl: number;
	};
	defaultSticky?: boolean;
	defaultTimeoutMs?: number;
	defaultRetries?: number;
	defaultBackoffMultiplier?: number;
	routes?: RouteConfig[];
}

export interface GlobalConfig {
	defaultStrategy: LbStrategy;
	defaultTimeoutMs: number;
	defaultRetries: number;
	defaultBackoffMultiplier: number;
	defaultCaching: {
		enabled: boolean;
		ttl: number;
	};
	chains: Record<string, ChainConfig>;
}

export interface CrawlResult {
	newEndpoints: number;
	totalEndpoints: number;
	misplacedEndpoints: number;
}

export interface CleanupResult {
	cleaned: number;
	remaining: number;
}

export interface ScheduledTask {
	name: string;
	schedule: string;
	handler: () => Promise<void> | void;
	enabled: boolean;
	lastRun?: Date;
	nextRun?: Date;
	description?: string;
}

export enum CircuitState {
	CLOSED = 'CLOSED',
	OPEN = 'OPEN',
	HALF_OPEN = 'HALF_OPEN',
}

// GitHub API response types
export interface GithubContent {
	name: string;
	type: string;
}

export interface ChainRegistryData {
	chain_name: string;
	chain_id: string;
	bech32_prefix: string;
	apis?: {
		rpc?: Array<{ address: string }>;
	};
}
