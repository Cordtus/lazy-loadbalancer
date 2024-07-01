export interface ChainEntry {
  chain_name: string;
  'chain-id': string;
  bech32_prefix: string;
  'account-prefix': string;
  'rpc-addresses': string[];
  apis?: {
    rpc: Array<{ address: string }>;
  };
  timeout: string;
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
    earliest_block_height: string;
    earliest_block_time: string;
  };
}
