import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChainEntry } from './types.js';
import logger from './logger.js';

// Workaround for __dirname in ES module
export function getDirName(metaUrl: string): string {
  const __filename = fileURLToPath(metaUrl);
  return path.dirname(__filename);
}

const CHAINS_FILE_PATH = path.resolve(getDirName(import.meta.url), '../data/chains.json');
const REJECTED_IPS_FILE_PATH = path.resolve(getDirName(import.meta.url), '../data/rejected_ips.json');
const GOOD_IPS_FILE_PATH = path.resolve(getDirName(import.meta.url), '../data/good_ips.json');
const LOGS_DIR_PATH = path.resolve(getDirName(import.meta.url), '../logs');

export function ensureFilesExist() {
  if (!fs.existsSync(path.dirname(CHAINS_FILE_PATH))) {
    fs.mkdirSync(path.dirname(CHAINS_FILE_PATH), { recursive: true });
  }
  if (!fs.existsSync(CHAINS_FILE_PATH)) {
    fs.writeFileSync(CHAINS_FILE_PATH, JSON.stringify({}));
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
}

export function loadChainsData(): Record<string, ChainEntry> {
  if (!fs.existsSync(path.dirname(CHAINS_FILE_PATH))) {
    fs.mkdirSync(path.dirname(CHAINS_FILE_PATH), { recursive: true });
  }
  ensureFilesExist();
  try {
    const data = fs.readFileSync(CHAINS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading chains file:', error);
    return {};
  }
}

export function saveChainsData(chainsData: Record<string, ChainEntry>) {
  if (!fs.existsSync(path.dirname(CHAINS_FILE_PATH))) {
    fs.mkdirSync(path.dirname(CHAINS_FILE_PATH), { recursive: true });
  }
  try {
    const existingData = loadChainsData();
    const updatedData = { ...existingData, ...chainsData };
    fs.writeFileSync(CHAINS_FILE_PATH, JSON.stringify(updatedData, null, 2));
    logger.info('Chains data saved.');
  } catch (error) {
    logger.error('Error writing chains file:', error);
  }
}

export function loadRejectedIPs(): Set<string> {
  if (!fs.existsSync(path.dirname(REJECTED_IPS_FILE_PATH))) {
    fs.mkdirSync(path.dirname(REJECTED_IPS_FILE_PATH), { recursive: true });
  }
  ensureFilesExist();
  try {
    const data = fs.readFileSync(REJECTED_IPS_FILE_PATH, 'utf-8');
    return new Set(JSON.parse(data));
  } catch (error) {
    console.error('Error reading rejected IPs file:', error);
    return new Set();
  }
}

export function saveRejectedIPs(rejectedIPs: Set<string>) {
  if (!fs.existsSync(path.dirname(REJECTED_IPS_FILE_PATH))) {
    fs.mkdirSync(path.dirname(REJECTED_IPS_FILE_PATH), { recursive: true });
  }
  try {
    fs.writeFileSync(REJECTED_IPS_FILE_PATH, JSON.stringify(Array.from(rejectedIPs), null, 2));
    console.log('Rejected IPs saved.');
  } catch (error) {
    console.error('Error writing rejected IPs file:', error);
  }
}

export function loadGoodIPs(): Record<string, number> {
  if (!fs.existsSync(path.dirname(GOOD_IPS_FILE_PATH))) {
    fs.mkdirSync(path.dirname(GOOD_IPS_FILE_PATH), { recursive: true });
  }
  ensureFilesExist();
  try {
    const data = fs.readFileSync(GOOD_IPS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading good IPs file:', error);
    return {};
  }
}

export function saveGoodIPs(goodIPs: Record<string, number>) {
  if (!fs.existsSync(path.dirname(GOOD_IPS_FILE_PATH))) {
    fs.mkdirSync(path.dirname(GOOD_IPS_FILE_PATH), { recursive: true });
  }
  try {
    fs.writeFileSync(GOOD_IPS_FILE_PATH, JSON.stringify(goodIPs, null, 2));
    console.log('Good IPs saved.');
  } catch (error) {
    console.error('Error writing good IPs file:', error);
  }
}

export function logToFile(moduleName: string, message: string) {
  ensureFilesExist();
  const logFilePath = path.resolve(LOGS_DIR_PATH, `${moduleName}.log`);
  fs.appendFileSync(logFilePath, `${new Date().toISOString()} - ${message}\n`);
}