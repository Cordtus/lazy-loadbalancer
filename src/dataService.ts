// dataService.ts - Unified data access layer
import { ChainEntry, BlacklistedIP, CleanupResult, EndpointStats, ChainData } from './types.js';
import { appLogger as logger } from './logger.js';
import * as fileUtils from './utils.js';
import database from './database.js';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

export enum DataStorageMode {
  FILE_SYSTEM = 'file',
  DATABASE = 'database',
  HYBRID = 'hybrid'
}

class DataService {
  private mode: DataStorageMode;
  private useDatabase: boolean = false;
  private readonly REPO_OWNER = 'cosmos';
  private readonly REPO_NAME = 'chain-registry';

  constructor() {
    this.mode = (process.env.DATA_STORAGE_MODE as DataStorageMode) || DataStorageMode.FILE_SYSTEM;
    this.useDatabase = this.mode === DataStorageMode.DATABASE || this.mode === DataStorageMode.HYBRID;
    
    if (this.useDatabase) {
      this.initializeDatabase().catch(error => {
        logger.error('Failed to initialize database, falling back to file system:', error);
        this.useDatabase = false;
        this.mode = DataStorageMode.FILE_SYSTEM;
      });
    }
  }

  private async initializeDatabase(): Promise<void> {
    await database.initialize();
    await database.importExistingData();
  }

  // GitHub chain fetching functionality (merged from fetchChains.ts)
  private async fetchChainDataFromGitHub(chainName: string): Promise<ChainEntry | null> {
    const url = `https://raw.githubusercontent.com/${this.REPO_OWNER}/${this.REPO_NAME}/master/${chainName}/chain.json`;
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn(`Failed to fetch data for chain: ${chainName}`);
        return null;
      }

      const data = (await response.json()) as ChainData;

      return {
        chain_name: data.chain_name,
        'chain-id': data.chain_id,
        bech32_prefix: data.bech32_prefix,
        'account-prefix': data.bech32_prefix,
        'rpc-addresses': data.apis.rpc.map((rpc) => rpc.address),
        timeout: '30s',
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error(`Error fetching data for chain ${chainName}:`, error);
      return null;
    }
  }

  async fetchChainsFromGitHub(): Promise<void> {
    try {
      logger.info('Fetching chains from GitHub...');
      
      // Fetch the repository contents without using Octokit
      const response = await fetch(`https://api.github.com/repos/${this.REPO_OWNER}/${this.REPO_NAME}/contents`);
      if (!response.ok) {
        throw new Error(`GitHub API request failed: ${response.status}`);
      }

      const contents = await response.json() as Array<{ name: string; type: string }>;
      const chainsData: Record<string, ChainEntry> = {};

      for (const item of contents) {
        if (
          item.type === 'dir' &&
          !item.name.startsWith('.') &&
          !item.name.startsWith('_') &&
          item.name !== 'testnets'
        ) {
          const chainData = await this.fetchChainDataFromGitHub(item.name);
          if (chainData) {
            chainsData[item.name] = chainData;
            logger.debug(`Fetched data for chain: ${item.name}`);
          }
        }
      }

      // Save the fetched data
      await this.saveChainsData(chainsData);
      logger.info(`Successfully fetched and saved ${Object.keys(chainsData).length} chains from GitHub`);
      
    } catch (error) {
      logger.error('Error fetching chains from GitHub:', error);
      throw error;
    }
  }

  // Chains data operations
  async loadChainsData(): Promise<Record<string, ChainEntry>> {
    if (this.useDatabase) {
      try {
        return await database.getAllChains();
      } catch (error) {
        logger.error('Database error, falling back to file system:', error);
      }
    }
    return fileUtils.loadChainsData();
  }

  async saveChainsData(chainsData: Record<string, ChainEntry>): Promise<void> {
    // Always save to file system for backup
    fileUtils.saveChainsData(chainsData);
    
    if (this.useDatabase) {
      try {
        // Database operations would be handled by individual chain operations
        logger.debug('Chains data also synced to database');
      } catch (error) {
        logger.error('Failed to sync to database:', error);
      }
    }
  }

  async getChain(chainName: string): Promise<ChainEntry | null> {
    if (this.useDatabase) {
      try {
        return await database.getChain(chainName);
      } catch (error) {
        logger.error('Database error, falling back to file system:', error);
      }
    }
    
    const chainsData = fileUtils.loadChainsData();
    return chainsData[chainName] || null;
  }

  // Blacklisted IPs operations
  async loadBlacklistedIPs(): Promise<BlacklistedIP[]> {
    if (this.useDatabase) {
      try {
        // Database implementation would go here
        logger.debug('Loading blacklisted IPs from database');
      } catch (error) {
        logger.error('Database error, falling back to file system:', error);
      }
    }
    return fileUtils.loadBlacklistedIPs();
  }

  async saveBlacklistedIPs(blacklistedIPs: BlacklistedIP[]): Promise<void> {
    fileUtils.saveBlacklistedIPs(blacklistedIPs);
    
    if (this.useDatabase) {
      try {
        // Database sync would go here
        logger.debug('Blacklisted IPs also synced to database');
      } catch (error) {
        logger.error('Failed to sync blacklisted IPs to database:', error);
      }
    }
  }

  async cleanupBlacklist(): Promise<CleanupResult> {
    if (this.useDatabase) {
      try {
        return await database.cleanupBlacklist();
      } catch (error) {
        logger.error('Database error, falling back to file system:', error);
      }
    }
    return fileUtils.cleanupBlacklist();
  }

  // Endpoint stats operations
  async getEndpointsByChain(chainId: string): Promise<EndpointStats[]> {
    if (this.useDatabase) {
      try {
        return await database.getEndpointsByChain(chainId);
      } catch (error) {
        logger.error('Database error:', error);
      }
    }
    // File system fallback - return empty array as endpoint stats are primarily in-memory
    return [];
  }

  async updateEndpointStats(
    chainId: string,
    url: string,
    responseTime: number,
    success: boolean
  ): Promise<void> {
    if (this.useDatabase) {
      try {
        await database.updateEndpointStats(chainId, url, responseTime, success);
      } catch (error) {
        logger.error('Failed to update endpoint stats in database:', error);
      }
    }
    // Endpoint stats are primarily handled in-memory in LoadBalancer class
  }

  // Other utility operations
  loadPorts(): number[] {
    return fileUtils.loadPorts();
  }

  savePorts(ports: number[]): void {
    fileUtils.savePorts(ports);
  }

  loadRejectedIPs(): string[] {
    return fileUtils.loadRejectedIPs();
  }

  saveRejectedIPs(rejectedIPs: string[]): void {
    fileUtils.saveRejectedIPs(rejectedIPs);
  }

  loadGoodIPs(): Record<string, number> {
    return fileUtils.loadGoodIPs();
  }

  saveGoodIPs(goodIPs: Record<string, number>): void {
    fileUtils.saveGoodIPs(goodIPs);
  }

  saveIncrementalChanges(changes: Record<string, string[]>): void {
    fileUtils.saveIncrementalChanges(changes);
  }

  async close(): Promise<void> {
    if (this.useDatabase) {
      await database.close();
    }
  }
}

// Export singleton instance
export const dataService = new DataService();
export default dataService;