// utils.ts - Consolidated implementation
import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath } from 'url';
import { appLogger as logger } from './logger.js';
import { ChainEntry, BlacklistedIP, CleanupResult } from './types.js';

export function getDirName(metaUrl: string | URL) {
  const __filename = fileURLToPath(metaUrl);
  return path.dirname(__filename);
}

const DATA_DIR = path.resolve(getDirName(import.meta.url), '../data');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PORTS_FILE_PATH = path.join(METADATA_DIR, 'ports.json');
const CHAIN_LIST_FILE_PATH = path.join(METADATA_DIR, 'chain_list.json');
const REJECTED_IPS_FILE_PATH = path.join(METADATA_DIR, 'rejected_ips.json');
const GOOD_IPS_FILE_PATH = path.join(METADATA_DIR, 'good_ips.json');
const BLACKLISTED_IPS_FILE_PATH = path.join(METADATA_DIR, 'blacklisted_ips.json');
const LOGS_DIR_PATH = path.resolve(getDirName(import.meta.url), '../logs');

export function ensureFilesExist() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(METADATA_DIR)) {
    fs.mkdirSync(METADATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CHAIN_LIST_FILE_PATH)) {
    fs.writeFileSync(CHAIN_LIST_FILE_PATH, JSON.stringify([]));
  }
  if (!fs.existsSync(REJECTED_IPS_FILE_PATH)) {
    fs.writeFileSync(REJECTED_IPS_FILE_PATH, JSON.stringify([]));
  }
  if (!fs.existsSync(GOOD_IPS_FILE_PATH)) {
    fs.writeFileSync(GOOD_IPS_FILE_PATH, JSON.stringify({}));
  }
  if (!fs.existsSync(LOGS_DIR_PATH)) {
    fs.mkdirSync(LOGS_DIR_PATH, { recursive: true });
  }
  if (!fs.existsSync(BLACKLISTED_IPS_FILE_PATH)) {
    fs.writeFileSync(BLACKLISTED_IPS_FILE_PATH, JSON.stringify([]));
  }
  if (!fs.existsSync(PORTS_FILE_PATH)) {
    fs.writeFileSync(PORTS_FILE_PATH, JSON.stringify([80, 443, 26657]));
  }
}

export function loadPorts(): number[] {
  ensureFilesExist();
  try {
    const data = fs.readFileSync(PORTS_FILE_PATH, 'utf-8');
    return JSON.parse(data).filter(
      (port: unknown): port is number => typeof port === 'number' && !isNaN(port)
    );
  } catch (error) {
    logger.error('Error reading ports file:', error);
    return [80, 443, 26657]; // Default ports
  }
}

export function savePorts(ports: number[]): void {
  try {
    const uniquePorts = [...new Set(ports)].sort((a, b) => a - b);
    fs.writeFileSync(PORTS_FILE_PATH, JSON.stringify(uniquePorts, null, 2));
    logger.info('Ports saved.');
  } catch (error) {
    logger.error('Error writing ports file:', error);
  }
}

export function loadChainsData(): Record<string, ChainEntry> {
  ensureFilesExist();
  try {
    const chainList = JSON.parse(fs.readFileSync(CHAIN_LIST_FILE_PATH, 'utf-8')) as string[];
    const chainsData: Record<string, ChainEntry> = {};

    for (const chainName of chainList) {
      const chainFilePath = path.join(DATA_DIR, `${chainName}.json`);
      if (fs.existsSync(chainFilePath)) {
        const chainData = JSON.parse(fs.readFileSync(chainFilePath, 'utf-8')) as ChainEntry;
        chainsData[chainName] = chainData;
      }
    }

    logger.info(`Loaded data for ${Object.keys(chainsData).length} chains`);
    return chainsData;
  } catch (error) {
    logger.error('Error reading chains data:', error);
    return {};
  }
}

export function saveChainsData(chainsData: Record<string, ChainEntry>) {
  try {
    const chainList = Object.keys(chainsData);
    fs.writeFileSync(CHAIN_LIST_FILE_PATH, JSON.stringify(chainList, null, 2));

    for (const [chainName, chainData] of Object.entries(chainsData)) {
      const chainFilePath = path.join(DATA_DIR, `${chainName}.json`);
      fs.writeFileSync(chainFilePath, JSON.stringify(chainData, null, 2));
    }

    logger.info('Chains data saved.');
  } catch (error) {
    logger.error('Error writing chains data:', error);
  }
}

export function loadRejectedIPs(): string[] {
  ensureFilesExist();
  try {
    const data = fs.readFileSync(REJECTED_IPS_FILE_PATH, 'utf-8');
    const parsedData = JSON.parse(data);
    if (Array.isArray(parsedData)) {
      return parsedData.filter((ip) => typeof ip === 'string');
    } else {
      logger.error('Rejected IPs file does not contain an array');
      return [];
    }
  } catch (error) {
    logger.error('Error reading rejected IPs file:', error);
    return [];
  }
}

export function saveRejectedIPs(rejectedIPs: string[]): void {
  try {
    fs.writeFileSync(REJECTED_IPS_FILE_PATH, JSON.stringify(rejectedIPs, null, 2));
    logger.info('Rejected IPs saved.');
  } catch (error) {
    logger.error('Error writing rejected IPs file:', error);
  }
}

export function loadGoodIPs(): Record<string, number> {
  ensureFilesExist();
  try {
    const data = fs.readFileSync(GOOD_IPS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    logger.error('Error reading good IPs file:', error);
    return {};
  }
}

export function saveGoodIPs(goodIPs: Record<string, number>): void {
  try {
    fs.writeFileSync(GOOD_IPS_FILE_PATH, JSON.stringify(goodIPs, null, 2));
    logger.info('Good IPs saved.');
  } catch (error) {
    logger.error('Error writing good IPs file:', error);
  }
}

export function loadBlacklistedIPs(): BlacklistedIP[] {
  ensureFilesExist();
  try {
    const data = fs.readFileSync(BLACKLISTED_IPS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    logger.error('Error reading blacklisted IPs file:', error);
    return [];
  }
}

export function saveBlacklistedIPs(blacklistedIPs: BlacklistedIP[]): void {
  try {
    fs.writeFileSync(BLACKLISTED_IPS_FILE_PATH, JSON.stringify(blacklistedIPs, null, 2));
    logger.info('Blacklisted IPs saved.');
  } catch (error) {
    logger.error('Error writing blacklisted IPs file:', error);
  }
}

export function cleanupBlacklist(): CleanupResult {
  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
  const originalBlacklist = loadBlacklistedIPs();

  const updatedBlacklist = originalBlacklist.filter(
    (entry) => entry.timestamp > sixHoursAgo || (entry.failureCount || 0) < 5
  );

  saveBlacklistedIPs(updatedBlacklist);

  return {
    cleaned: originalBlacklist.length - updatedBlacklist.length,
    remaining: updatedBlacklist.length,
  };
}

export function logToFile(moduleName: string, message: string) {
  ensureFilesExist();
  const logFilePath = path.resolve(LOGS_DIR_PATH, `${moduleName}.log`);
  fs.appendFileSync(logFilePath, `${new Date().toISOString()} - ${message}\n`);
}

export function saveIncrementalChanges(changes: Record<string, string[]>): void {
  logger.info('Saving incremental changes', changes);

  try {
    const chainList = JSON.parse(fs.readFileSync(CHAIN_LIST_FILE_PATH, 'utf-8')) as string[];

    // Update chain data
    for (const chainName of chainList) {
      const chainFilePath = path.join(DATA_DIR, `${chainName}.json`);
      if (fs.existsSync(chainFilePath)) {
        const chainData = JSON.parse(fs.readFileSync(chainFilePath, 'utf-8')) as ChainEntry;

        // Add new endpoints
        if (changes.newEndpoints) {
          const newEndpoints = changes.newEndpoints.filter(
            (endpoint) =>
              endpoint.includes(chainName) ||
              endpoint.toLowerCase().includes(chainName.toLowerCase())
          );
          chainData['rpc-addresses'] = [
            ...new Set([...chainData['rpc-addresses'], ...newEndpoints]),
          ];
        }

        // Remove endpoints
        if (changes.removedEndpoints) {
          const removedEndpoints = changes.removedEndpoints.filter(
            (endpoint) =>
              endpoint.includes(chainName) ||
              endpoint.toLowerCase().includes(chainName.toLowerCase())
          );
          chainData['rpc-addresses'] = chainData['rpc-addresses'].filter(
            (endpoint) => !removedEndpoints.includes(endpoint)
          );
        }

        chainData.lastUpdated = new Date().toISOString();
        fs.writeFileSync(chainFilePath, JSON.stringify(chainData, null, 2));
      }
    }

    // Update blacklisted IPs
    if (changes.updatedBlacklist && changes.updatedBlacklist.length > 0) {
      const blacklistedIPs = loadBlacklistedIPs();
      for (const ip of changes.updatedBlacklist) {
        const existingEntry = blacklistedIPs.find((entry) => entry.ip === ip);
        if (existingEntry) {
          existingEntry.failureCount = (existingEntry.failureCount || 0) + 1;
          existingEntry.timestamp = Date.now();
        } else {
          blacklistedIPs.push({ ip, failureCount: 1, timestamp: Date.now() });
        }
      }
      saveBlacklistedIPs(blacklistedIPs);
    }

    // Update good IPs
    if (changes.newEndpoints && changes.newEndpoints.length > 0) {
      const goodIPs = loadGoodIPs();
      for (const endpoint of changes.newEndpoints) {
        try {
          const hostname = new URL(endpoint).hostname;
          goodIPs[hostname] = Date.now();
        } catch (error) {
          logger.error(`Invalid URL: ${endpoint}`);
        }
      }
      saveGoodIPs(goodIPs);
    }

    logger.info('Incremental changes saved successfully');
  } catch (error) {
    logger.error('Error saving incremental changes:', error);
  }
}
