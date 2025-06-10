// database.ts
import { Pool, PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';
import { appLogger as logger } from './logger.js';
import { ChainEntry, EndpointStats } from './types.js';

export class Database {
  private pool: Pool;
  private initialized: boolean = false;

  constructor() {
    this.pool = new Pool({
      user: process.env.DB_USER || 'cosmos',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'loadbalancer',
      password: process.env.DB_PASSWORD || 'cosmos',
      port: parseInt(process.env.DB_PORT || '5432'),
      max: 20, // Maximum number of clients in the pool
      idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
      connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection cannot be established
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();

      // Create chains table
      await client.query(`
        CREATE TABLE IF NOT EXISTS chains (
          id SERIAL PRIMARY KEY,
          chain_name TEXT UNIQUE NOT NULL,
          chain_id TEXT UNIQUE NOT NULL,
          bech32_prefix TEXT NOT NULL,
          account_prefix TEXT NOT NULL,
          timeout TEXT NOT NULL DEFAULT '30s',
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // Create endpoints table
      await client.query(`
        CREATE TABLE IF NOT EXISTS endpoints (
          id SERIAL PRIMARY KEY,
          chain_id TEXT NOT NULL,
          url TEXT NOT NULL,
          success_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          response_time INTEGER NOT NULL DEFAULT 0,
          weight FLOAT NOT NULL DEFAULT 1.0,
          last_check TIMESTAMP NOT NULL DEFAULT NOW(),
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          UNIQUE(chain_id, url)
        )
      `);

      // Create blacklist table
      await client.query(`
        CREATE TABLE IF NOT EXISTS blacklisted_ips (
          id SERIAL PRIMARY KEY,
          ip TEXT UNIQUE NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          timestamp TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // Create rejected IPs table
      await client.query(`
        CREATE TABLE IF NOT EXISTS rejected_ips (
          id SERIAL PRIMARY KEY,
          ip TEXT UNIQUE NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // Create good IPs table
      await client.query(`
        CREATE TABLE IF NOT EXISTS good_ips (
          id SERIAL PRIMARY KEY,
          ip TEXT UNIQUE NOT NULL,
          last_success TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);

      // Create known ports table
      await client.query(`
        CREATE TABLE IF NOT EXISTS known_ports (
          id SERIAL PRIMARY KEY,
          port INTEGER UNIQUE NOT NULL
        )
      `);

      // Insert default ports if the table is empty
      await client.query(`
        INSERT INTO known_ports (port)
        SELECT * FROM UNNEST(ARRAY[80, 443, 26657])
        ON CONFLICT DO NOTHING
      `);

      this.initialized = true;
      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error('Error initializing database:', error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async importExistingData(): Promise<void> {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      logger.warn('Data directory does not exist, skipping import');
      return;
    }

    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();

      // Get list of all json files in data directory
      const files = fs
        .readdirSync(dataDir)
        .filter((file) => file.endsWith('.json') && !file.includes('_'));

      for (const file of files) {
        const chainName = file.replace('.json', '');
        if (chainName !== 'chain_list' && chainName !== 'ports' && !chainName.includes('ips')) {
          const chainData = JSON.parse(
            fs.readFileSync(path.join(dataDir, file), 'utf8')
          ) as ChainEntry;

          // Insert chain
          await client.query(
            `
            INSERT INTO chains (chain_name, chain_id, bech32_prefix, account_prefix, timeout)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (chain_name) DO UPDATE
            SET chain_id = $2, bech32_prefix = $3, account_prefix = $4, timeout = $5, updated_at = NOW()
          `,
            [
              chainData.chain_name,
              chainData['chain-id'],
              chainData.bech32_prefix,
              chainData['account-prefix'],
              chainData.timeout,
            ]
          );

          // Insert endpoints
          for (const endpoint of chainData['rpc-addresses']) {
            await client.query(
              `
              INSERT INTO endpoints (chain_id, url)
              VALUES ($1, $2)
              ON CONFLICT (chain_id, url) DO NOTHING
            `,
              [chainData['chain-id'], endpoint]
            );
          }
        }
      }

      // Import blacklisted IPs
      if (fs.existsSync(path.join(dataDir, 'blacklisted_ips.json'))) {
        const blacklistedIPs = JSON.parse(
          fs.readFileSync(path.join(dataDir, 'blacklisted_ips.json'), 'utf8')
        );
        for (const ip of blacklistedIPs) {
          await client.query(
            `
            INSERT INTO blacklisted_ips (ip, failure_count, timestamp)
            VALUES ($1, $2, to_timestamp($3 / 1000.0))
            ON CONFLICT (ip) DO UPDATE
            SET failure_count = $2, timestamp = to_timestamp($3 / 1000.0)
          `,
            [ip.ip, ip.failureCount, ip.timestamp]
          );
        }
      }

      // Import rejected IPs
      if (fs.existsSync(path.join(dataDir, 'rejected_ips.json'))) {
        const rejectedIPs = JSON.parse(
          fs.readFileSync(path.join(dataDir, 'rejected_ips.json'), 'utf8')
        );
        for (const ip of rejectedIPs) {
          await client.query(
            `
            INSERT INTO rejected_ips (ip)
            VALUES ($1)
            ON CONFLICT (ip) DO NOTHING
          `,
            [ip]
          );
        }
      }

      // Import good IPs
      if (fs.existsSync(path.join(dataDir, 'good_ips.json'))) {
        const goodIPs = JSON.parse(fs.readFileSync(path.join(dataDir, 'good_ips.json'), 'utf8'));
        for (const [ip, timestamp] of Object.entries(goodIPs)) {
          await client.query(
            `
            INSERT INTO good_ips (ip, last_success)
            VALUES ($1, to_timestamp($2 / 1000.0))
            ON CONFLICT (ip) DO UPDATE
            SET last_success = to_timestamp($2 / 1000.0)
          `,
            [ip, timestamp]
          );
        }
      }

      // Import ports
      if (fs.existsSync(path.join(dataDir, 'ports.json'))) {
        const ports = JSON.parse(fs.readFileSync(path.join(dataDir, 'ports.json'), 'utf8'));
        for (const port of ports) {
          await client.query(
            `
            INSERT INTO known_ports (port)
            VALUES ($1)
            ON CONFLICT (port) DO NOTHING
          `,
            [port]
          );
        }
      }

      logger.info('Successfully imported existing data');
    } catch (error) {
      logger.error('Error importing existing data:', error);
      throw error;
    } finally {
      if (client) client.release();
    }
  }

  async getChain(chainName: string): Promise<ChainEntry | null> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();

      // Get chain
      const chainResult = await client.query(
        `
        SELECT * FROM chains WHERE chain_name = $1
      `,
        [chainName]
      );

      if (chainResult.rows.length === 0) {
        return null;
      }

      // Get endpoints
      const endpointsResult = await client.query(
        `
        SELECT url FROM endpoints WHERE chain_id = $1
      `,
        [chainResult.rows[0].chain_id]
      );

      const endpoints = endpointsResult.rows.map((row) => row.url);

      return {
        chain_name: chainResult.rows[0].chain_name,
        'chain-id': chainResult.rows[0].chain_id,
        bech32_prefix: chainResult.rows[0].bech32_prefix,
        'account-prefix': chainResult.rows[0].account_prefix,
        'rpc-addresses': endpoints,
        timeout: chainResult.rows[0].timeout,
        lastUpdated: chainResult.rows[0].updated_at.toISOString(),
      };
    } catch (error) {
      logger.error(`Error getting chain ${chainName}:`, error);
      return null;
    } finally {
      if (client) client.release();
    }
  }

  async getAllChains(): Promise<Record<string, ChainEntry>> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();

      // Get all chains
      const chainsResult = await client.query(`
        SELECT * FROM chains
      `);

      const chainsData: Record<string, ChainEntry> = {};

      for (const chain of chainsResult.rows) {
        // Get endpoints for this chain
        const endpointsResult = await client.query(
          `
          SELECT url FROM endpoints WHERE chain_id = $1
        `,
          [chain.chain_id]
        );

        const endpoints = endpointsResult.rows.map((row) => row.url);

        chainsData[chain.chain_name] = {
          chain_name: chain.chain_name,
          'chain-id': chain.chain_id,
          bech32_prefix: chain.bech32_prefix,
          'account-prefix': chain.account_prefix,
          'rpc-addresses': endpoints,
          timeout: chain.timeout,
          lastUpdated: chain.updated_at.toISOString(),
        };
      }

      return chainsData;
    } catch (error) {
      logger.error('Error getting all chains:', error);
      return {};
    } finally {
      if (client) client.release();
    }
  }

  async getEndpointsByChain(chainId: string): Promise<EndpointStats[]> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();

      const result = await client.query(
        `
        SELECT 
          url, 
          success_count, 
          failure_count, 
          response_time, 
          weight,
          last_check as lastSeen,
          CASE 
            WHEN (success_count + failure_count) = 0 THEN 1.0
            ELSE success_count::float / (success_count + failure_count)
          END as successRate,
          response_time as avgLatency,
          success_count as responseCount,
          failure_count as failureCount
        FROM 
          endpoints 
        WHERE 
          chain_id = $1
      `,
        [chainId]
      );

      return result.rows.map((row) => ({
        address: row.url,
        weight: row.weight,
        responseTime: row.response_time,
        successCount: row.success_count,
        failureCount: row.failure_count,
        successRate: row.successrate,
        avgLatency: row.avglatency,
        responseCount: row.responsecount,
        features: {},
      }));
    } catch (error) {
      logger.error(`Error getting endpoints for chain ${chainId}:`, error);
      return [];
    } finally {
      if (client) client.release();
    }
  }

  async updateEndpointStats(
    chainId: string,
    url: string,
    responseTime: number,
    success: boolean
  ): Promise<void> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();

      // Get current stats
      const result = await client.query(
        `
        SELECT response_time, success_count, failure_count
        FROM endpoints
        WHERE chain_id = $1 AND url = $2
      `,
        [chainId, url]
      );

      if (result.rows.length === 0) {
        // Endpoint doesn't exist
        return;
      }

      const currentStats = result.rows[0];
      let newResponseTime = responseTime;

      // Update response time with weighted average (80% old, 20% new)
      if (currentStats.response_time > 0) {
        newResponseTime = 0.8 * currentStats.response_time + 0.2 * responseTime;
      }

      // Update success/failure count
      const successCount = success ? currentStats.success_count + 1 : currentStats.success_count;
      const failureCount = success ? currentStats.failure_count : currentStats.failure_count + 1;

      // Calculate new weight
      const successRate = successCount / (successCount + failureCount);
      const normalizedResponseTime = Math.min(newResponseTime, 5000) / 5000; // Normalize to 0-1 range
      const weight = successRate * 0.7 + (1 - normalizedResponseTime) * 0.3;

      // Update endpoint
      await client.query(
        `
        UPDATE endpoints
        SET 
          response_time = $3,
          success_count = $4,
          failure_count = $5,
          weight = $6,
          last_check = NOW(),
          updated_at = NOW()
        WHERE chain_id = $1 AND url = $2
      `,
        [chainId, url, newResponseTime, successCount, failureCount, weight]
      );
    } catch (error) {
      logger.error(`Error updating endpoint stats for ${url}:`, error);
    } finally {
      if (client) client.release();
    }
  }

  async cleanupBlacklist(): Promise<{ cleaned: number; remaining: number }> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();

      // Delete entries older than 6 hours with failure count < 5
      const result = await client.query(`
        DELETE FROM blacklisted_ips
        WHERE timestamp < NOW() - INTERVAL '6 hours' AND failure_count < 5
        RETURNING id
      `);

      const cleaned = result.rowCount || 0;

      // Count remaining entries
      const countResult = await client.query(`
        SELECT COUNT(*) FROM blacklisted_ips
      `);

      const remaining = parseInt(countResult.rows[0].count) || 0;

      return { cleaned, remaining };
    } catch (error) {
      logger.error('Error cleaning up blacklist:', error);
      return { cleaned: 0, remaining: 0 };
    } finally {
      if (client) client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// Create and export a singleton instance
const database = new Database();
export default database;
