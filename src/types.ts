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
}

export interface NetInfo {
  peers: Array<{
    remote_ip: string;
    node_info: {
      other: {
        rpc_address: string;
      };
    };
  }>;
}

export interface StatusInfo {
  sync_info: {
    latest_block_height: string;
    latest_block_time: string;
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
