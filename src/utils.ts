// utils.ts
import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath } from 'url';
import { appLogger as logger } from './logger.js';
import { ChainEntry, BlacklistedIP } from './types.js';
import config from './config.js';

export function getDirName(metaUrl: string | URL) {
    const __filename = fileURLToPath(metaUrl);
    return path.dirname(__filename);
}

const DATA_DIR = path.resolve(getDirName(import.meta.url), '../data');
const PORTS_FILE_PATH = path.join(DATA_DIR, 'ports.json');
const CHAIN_LIST_FILE_PATH = path.join(DATA_DIR, 'chain_list.json');
const REJECTED_IPS_FILE_PATH = path.join(DATA_DIR, 'rejected_ips.json');
const GOOD_IPS_FILE_PATH = path.join(DATA_DIR, 'good_ips.json');
const LOGS_DIR_PATH = path.resolve(getDirName(import.meta.url), '../logs');
const BLACKLISTED_IPS_FILE_PATH = path.join(DATA_DIR, 'blacklisted_ips.json');

export function ensureFilesExist() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
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
        fs.mkdirSync(LOGS_DIR_PATH);
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
        return JSON.parse(data);
    } catch (error) {
        logger.error('Error reading ports file:', error);
        return [80, 443, 26657]; // Default ports
    }
}

export function savePorts(ports: number[]): void {
    try {
        fs.writeFileSync(PORTS_FILE_PATH, JSON.stringify(ports, null, 2));
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
        const now = Date.now();
        const updateInterval = config.chains.checkInterval;
        
        for (const chainName of chainList) {
            const chainFilePath = path.join(DATA_DIR, `${chainName}.json`);
            if (fs.existsSync(chainFilePath)) {
                const chainData = JSON.parse(fs.readFileSync(chainFilePath, 'utf-8')) as ChainEntry;
                if (!chainData.timestamp || now - chainData.timestamp > updateInterval) {
                    logger.info(`Chain ${chainName} data is outdated and needs updating.`);
                }
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

export function loadRejectedIPs(): Set<string> {
    if (!fs.existsSync(path.dirname(REJECTED_IPS_FILE_PATH))) {
        fs.mkdirSync(path.dirname(REJECTED_IPS_FILE_PATH), { recursive: true });
    }
    ensureFilesExist();
    try {
        const data = fs.readFileSync(REJECTED_IPS_FILE_PATH, 'utf-8');
        const parsedData = JSON.parse(data);
        if (Array.isArray(parsedData)) {
            return new Set(parsedData.filter(ip => typeof ip === 'string'));
        } else {
            logger.error('Rejected IPs file does not contain an array');
            return new Set<string>();
        }
    }
    catch (error) {
        logger.error('Error reading rejected IPs file:', error);
        return new Set<string>();
    }
}

export function saveRejectedIPs(rejectedIPs: Iterable<unknown> | ArrayLike<unknown>) {
    if (!fs.existsSync(path.dirname(REJECTED_IPS_FILE_PATH))) {
        fs.mkdirSync(path.dirname(REJECTED_IPS_FILE_PATH), { recursive: true });
    }
    try {
        fs.writeFileSync(REJECTED_IPS_FILE_PATH, JSON.stringify(Array.from(rejectedIPs), null, 2));
        logger.info('Rejected IPs saved.');
    }
    catch (error) {
        logger.error('Error writing rejected IPs file:', error);
    }
}

export function loadGoodIPs(): Record<string, boolean> {
    if (!fs.existsSync(path.dirname(GOOD_IPS_FILE_PATH))) {
      fs.mkdirSync(path.dirname(GOOD_IPS_FILE_PATH), { recursive: true });
    }
    ensureFilesExist();
    try {
      const data = fs.readFileSync(GOOD_IPS_FILE_PATH, 'utf-8');
      return JSON.parse(data);
    }
    catch (error) {
      logger.error('Error reading good IPs file:', error);
      return {};
    }
  }

export function saveGoodIPs(goodIPs: any) {
    if (!fs.existsSync(path.dirname(GOOD_IPS_FILE_PATH))) {
        fs.mkdirSync(path.dirname(GOOD_IPS_FILE_PATH), { recursive: true });
    }
    try {
        fs.writeFileSync(GOOD_IPS_FILE_PATH, JSON.stringify(goodIPs, null, 2));
        logger.info('Good IPs saved.');
    }
    catch (error) {
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

export function cleanupBlacklist(): void {
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const updatedBlacklist = loadBlacklistedIPs().filter(entry => 
      entry.timestamp > sixHoursAgo || (entry.failureCount || 0) < 5
    );
    saveBlacklistedIPs(updatedBlacklist);
  }

export function logToFile(moduleName: string, message: string) {
    ensureFilesExist();
    const logFilePath = path.resolve(LOGS_DIR_PATH, `${moduleName}.log`);
    fs.appendFileSync(logFilePath, `${new Date().toISOString()} - ${message}\n`);
}