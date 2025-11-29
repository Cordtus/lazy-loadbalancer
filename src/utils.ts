// File utilities using Bun's native APIs
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appLogger as logger } from './logger.ts';
import type { BlacklistedIP, ChainEntry, CleanupResult } from './types.ts';

const DATA_DIR = join(process.cwd(), 'data');
const METADATA_DIR = join(DATA_DIR, 'metadata');
const PORTS_FILE = join(METADATA_DIR, 'ports.json');
const CHAIN_LIST_FILE = join(METADATA_DIR, 'chain_list.json');
const REJECTED_IPS_FILE = join(METADATA_DIR, 'rejected_ips.json');
const GOOD_IPS_FILE = join(METADATA_DIR, 'good_ips.json');
const BLACKLISTED_IPS_FILE = join(METADATA_DIR, 'blacklisted_ips.json');
const LOGS_DIR = join(process.cwd(), 'logs');

export function ensureFilesExist(): void {
	const dirs = [DATA_DIR, METADATA_DIR, LOGS_DIR];
	for (const dir of dirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	const defaults: Array<[string, string]> = [
		[CHAIN_LIST_FILE, '[]'],
		[REJECTED_IPS_FILE, '[]'],
		[GOOD_IPS_FILE, '{}'],
		[BLACKLISTED_IPS_FILE, '[]'],
		[PORTS_FILE, '[80, 443, 26657]'],
	];

	for (const [file, content] of defaults) {
		if (!existsSync(file)) {
			Bun.write(file, content);
		}
	}
}

function readJsonSync<T>(path: string, fallback: T): T {
	try {
		if (!existsSync(path)) return fallback;
		const content = readFileSync(path, 'utf-8');
		if (!content) return fallback;
		return JSON.parse(content);
	} catch (err) {
		logger.error(`Error reading ${path}`, err);
		return fallback;
	}
}

function writeJson(path: string, data: unknown): void {
	try {
		Bun.write(path, JSON.stringify(data, null, 2));
	} catch (err) {
		logger.error(`Error writing ${path}`, err);
	}
}

// Common Tendermint/CometBFT RPC ports with variations
const DEFAULT_PORTS = [
	// Standard ports
	80,
	443,
	26657,
	// Common variations: increment digits in 26657
	36657,
	46657,
	56657,
	16657, // first digit
	27657,
	28657,
	29657,
	25657, // second digit
	26757,
	26857,
	26957,
	26557, // third digit
	26667,
	26677,
	26687,
	26647, // fourth digit
	26658,
	26659,
	26656,
	26655, // fifth digit
	// Other common custom ports
	1317,
	9090,
	9091,
	8545,
	8546, // API/gRPC/EVM ports often co-located
	26656, // P2P port sometimes exposes RPC
	14957,
	14917,
	14657, // Cosmos SDK custom ports
	443,
	8080,
	8443,
	3000, // Generic web ports
];

export function loadPorts(): number[] {
	ensureFilesExist();
	const ports = readJsonSync<unknown[]>(PORTS_FILE, DEFAULT_PORTS);
	return ports.filter((p): p is number => typeof p === 'number' && !Number.isNaN(p));
}

export function savePorts(ports: number[]): void {
	const unique = [...new Set(ports)].sort((a, b) => a - b);
	writeJson(PORTS_FILE, unique);
	logger.info('Ports saved');
}

export function loadChainsData(): Record<string, ChainEntry> {
	ensureFilesExist();
	try {
		const chainList = readJsonSync<string[]>(CHAIN_LIST_FILE, []);
		const chainsData: Record<string, ChainEntry> = {};

		for (const chainName of chainList) {
			const chainPath = join(DATA_DIR, `${chainName}.json`);
			if (existsSync(chainPath)) {
				const data = readJsonSync<ChainEntry | null>(chainPath, null);
				if (data) chainsData[chainName] = data;
			}
		}

		logger.info(`Loaded data for ${Object.keys(chainsData).length} chains`);
		return chainsData;
	} catch (err) {
		logger.error('Error loading chains data', err);
		return {};
	}
}

export function saveChainsData(chainsData: Record<string, ChainEntry>): void {
	try {
		const chainList = Object.keys(chainsData);
		writeJson(CHAIN_LIST_FILE, chainList);

		for (const [chainName, chainData] of Object.entries(chainsData)) {
			writeJson(join(DATA_DIR, `${chainName}.json`), chainData);
		}

		logger.info('Chains data saved');
	} catch (err) {
		logger.error('Error saving chains data', err);
	}
}

export function loadRejectedIPs(): string[] {
	ensureFilesExist();
	const data = readJsonSync<unknown[]>(REJECTED_IPS_FILE, []);
	return data.filter((ip): ip is string => typeof ip === 'string');
}

export function saveRejectedIPs(rejectedIPs: string[]): void {
	writeJson(REJECTED_IPS_FILE, rejectedIPs);
	logger.info('Rejected IPs saved');
}

export function loadGoodIPs(): Record<string, number> {
	ensureFilesExist();
	return readJsonSync<Record<string, number>>(GOOD_IPS_FILE, {});
}

export function saveGoodIPs(goodIPs: Record<string, number>): void {
	writeJson(GOOD_IPS_FILE, goodIPs);
	logger.info('Good IPs saved');
}

export function loadBlacklistedIPs(): BlacklistedIP[] {
	ensureFilesExist();
	return readJsonSync<BlacklistedIP[]>(BLACKLISTED_IPS_FILE, []);
}

export function saveBlacklistedIPs(blacklistedIPs: BlacklistedIP[]): void {
	writeJson(BLACKLISTED_IPS_FILE, blacklistedIPs);
	logger.info('Blacklisted IPs saved');
}

export function cleanupBlacklist(): CleanupResult {
	const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
	const original = loadBlacklistedIPs();

	const updated = original.filter(
		(entry) => entry.timestamp > sixHoursAgo || (entry.failureCount || 0) < 5
	);

	saveBlacklistedIPs(updated);

	return {
		cleaned: original.length - updated.length,
		remaining: updated.length,
	};
}

export function isPrivateIP(ip: string): boolean {
	const parts = ip.split('.');
	if (parts.length !== 4) return false;
	const [first, second] = parts.map((p) => Number.parseInt(p, 10));
	return (
		first === 10 ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168)
	);
}

export function normalizeUrl(input: string): string | null {
	let url = input.trim();
	if (!url.startsWith('http://') && !url.startsWith('https://')) {
		url = `http://${url}`;
	}
	try {
		const parsed = new URL(url);
		// Strip ALL trailing slashes to normalize inputs like 'https://example.com//' -> 'https://example.com'
		return parsed.toString().replace(/\/+$/, '');
	} catch {
		return null;
	}
}

export function isValidUrl(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}
