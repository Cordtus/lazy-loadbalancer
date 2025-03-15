export interface ChainEntry {
  chain_name: string;
  'chain-id': string;
  bech32_prefix: string;
  'account-prefix': string;
  'rpc-addresses': string[];
  timeout: string;
  apis?: {
    rpc: Array<{ address: string }>;
  };
  timestamp?: number;
  lastUpdated?: string;
  lastCrawled?: string;
}

export interface NetInfo {
  peers: Array<Peer>;
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

export interface StatusInfo {
  node_info: {
    other: {
      tx_index: string;
    };
  };
  sync_info: {
    latest_block_height: string;
    latest_block_time: string;
  };
}

export interface StatusResponse {
  result: {
    node_info: {
      [x: string]: any;
      network: string;
    };
    sync_info: {
      latest_block_time: string;
    };
  };
}

export interface Api {
  address: string;
}

export interface ChainData {
  chain_name: string;
  chain_id: string;
  bech32_prefix: string;
  slip44: number;
  apis: {
    rpc: Api[];
    rest: Api[];
  };
}

export interface ErrorResponse {
  message: string;
  stack?: string;
}

export interface BlacklistedIP {
  ip: string;
  failureCount: number;
  timestamp: number;
}

export interface LoadBalancerStrategy {
  type: 'round-robin' | 'weighted' | 'least-connections' | 'random' | 'ip-hash';
  options?: Record<string, any>;
}

export interface EndpointFilters {
  whitelist?: string[];
  blacklist?: string[];
}

export interface RouteConfig {
  path: string;
  strategy?: LoadBalancerStrategy;
  filters?: EndpointFilters;
  caching?: {
    enabled: boolean;
    ttl: number; // in seconds
  };
  sticky?: boolean;
  timeoutMs?: number;
  retries?: number;
  backoffMultiplier?: number;
  priority?: number; // higher number = higher priority
}

export interface ChainConfig {
  defaultStrategy: LoadBalancerStrategy;
  defaultFilters?: EndpointFilters;
  defaultCaching?: {
    enabled: boolean;
    ttl: number; // in seconds
  };
  defaultSticky?: boolean;
  defaultTimeoutMs?: number;
  defaultRetries?: number;
  defaultBackoffMultiplier?: number;
  routes?: RouteConfig[];
}

export interface GlobalConfig {
  defaultStrategy: LoadBalancerStrategy;
  defaultTimeoutMs: number;
  defaultRetries: number;
  defaultBackoffMultiplier: number;
  defaultCaching: {
    enabled: boolean;
    ttl: number;
  };
  chains: Record<string, ChainConfig>;
}