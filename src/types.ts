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