import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChainEntry } from './types.js';

// Workaround for __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHAINS_FILE_PATH = path.resolve(__dirname, '../data/chains.json');

export function ensureChainsFileExists() {
  if (!fs.existsSync(CHAINS_FILE_PATH)) {
    fs.writeFileSync(CHAINS_FILE_PATH, JSON.stringify({}));
  }
}

export function loadChainsData(): Record<string, ChainEntry> {
  ensureChainsFileExists();
  try {
    const data = fs.readFileSync(CHAINS_FILE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading chains file:', error);
    return {};
  }
}

export function saveChainsData(chainsData: Record<string, ChainEntry>) {
  try {
    fs.writeFileSync(CHAINS_FILE_PATH, JSON.stringify(chainsData, null, 2));
    console.log('Chains data saved.');
  } catch (error) {
    console.error('Error writing chains file:', error);
  }
}
