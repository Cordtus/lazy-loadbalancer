import { REPO_NAME, REPO_OWNER } from './config.ts';
import { appLogger as logger } from './logger.ts';
import type {
	ChainEntry,
	GithubContent,
	IbcLink,
	IbcLinkResolutionResult,
	IbcRegistryFile,
} from './types.ts';

interface RegistryFileInput {
	name: string;
	data: IbcRegistryFile;
}

interface ResolveFromFilesOptions {
	source: string;
	destination: string;
	chainsData: Record<string, ChainEntry>;
	files: RegistryFileInput[];
}

interface ResolveFromRegistryOptions {
	source: string;
	destination: string;
	chainsData: Record<string, ChainEntry>;
	fetchFn?: typeof fetch;
	now?: () => number;
}

const IBC_CACHE_TTL_MS = 10 * 60 * 1000;
const GITHUB_CONTENTS_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/_IBC`;
const RAW_IBC_BASE_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/_IBC`;

let directoryCache: { expiresAt: number; files: GithubContent[] } | null = null;
const fileCache = new Map<string, { expiresAt: number; data: IbcRegistryFile }>();

function normalizeChainKey(value: string): string {
	return value.trim().toLowerCase();
}

function chainIdFor(name: string, chainsData: Record<string, ChainEntry>): string {
	return chainsData[name]?.chainId || '';
}

export function resolveChainAlias(
	input: string,
	chainsData: Record<string, ChainEntry>
): string | null {
	const normalizedInput = normalizeChainKey(input);
	if (!normalizedInput) return null;

	for (const [name, chain] of Object.entries(chainsData)) {
		const aliases = [name, chain.chainName, chain.chainId].map(normalizeChainKey);
		if (aliases.includes(normalizedInput)) {
			return name;
		}
	}

	return null;
}

function compareLinks(a: IbcLink, b: IbcLink): number {
	const preferredDelta = Number(b.tags.preferred === true) - Number(a.tags.preferred === true);
	if (preferredDelta !== 0) return preferredDelta;

	const activeDelta = Number(isActiveStatus(b.tags.status)) - Number(isActiveStatus(a.tags.status));
	if (activeDelta !== 0) return activeDelta;

	const transferDelta = Number(b.portId === 'transfer') - Number(a.portId === 'transfer');
	if (transferDelta !== 0) return transferDelta;

	return `${a.destinationChainName}:${a.channelId}`.localeCompare(
		`${b.destinationChainName}:${b.channelId}`
	);
}

function isActiveStatus(status: string | undefined): boolean {
	const normalized = status?.trim().toUpperCase();
	return normalized === 'ACTIVE' || normalized === 'LIVE';
}

function mapRegistryFile(
	file: RegistryFileInput,
	sourceName: string,
	destinationName: string,
	chainsData: Record<string, ChainEntry>
): IbcLink[] {
	const chain1Name = normalizeChainKey(file.data.chain_1.chain_name);
	const chain2Name = normalizeChainKey(file.data.chain_2.chain_name);
	const sourceKey = normalizeChainKey(sourceName);
	const destinationKey = normalizeChainKey(destinationName);

	let sourceSide: 'chain_1' | 'chain_2' | null = null;
	if (chain1Name === sourceKey && chain2Name === destinationKey) {
		sourceSide = 'chain_1';
	} else if (chain2Name === sourceKey && chain1Name === destinationKey) {
		sourceSide = 'chain_2';
	}

	if (!sourceSide) {
		return [];
	}

	const counterpartySide = sourceSide === 'chain_1' ? 'chain_2' : 'chain_1';
	const sourceChain = file.data[sourceSide];
	const counterpartyChain = file.data[counterpartySide];

	return file.data.channels.map((channel) => {
		const sourceChannel = channel[sourceSide];
		const counterpartyChannel = channel[counterpartySide];

		return {
			sourceChainName: sourceName,
			sourceChainId: chainIdFor(sourceName, chainsData),
			destinationChainName: destinationName,
			destinationChainId: chainIdFor(destinationName, chainsData),
			channelId: sourceChannel.channel_id,
			portId: sourceChannel.port_id || 'transfer',
			counterpartyChannelId: counterpartyChannel.channel_id,
			counterpartyPortId: counterpartyChannel.port_id || 'transfer',
			clientId: sourceChannel.client_id || sourceChain.client_id,
			counterpartyClientId: counterpartyChannel.client_id || counterpartyChain.client_id,
			connectionId: sourceChannel.connection_id || sourceChain.connection_id,
			counterpartyConnectionId:
				counterpartyChannel.connection_id || counterpartyChain.connection_id,
			ordering: channel.ordering,
			version: channel.version,
			tags: channel.tags || {},
			sourceFile: file.name,
		};
	});
}

export function resolveIbcLinksFromRegistryFiles({
	source,
	destination,
	chainsData,
	files,
}: ResolveFromFilesOptions): IbcLinkResolutionResult {
	const sourceName = resolveChainAlias(source, chainsData);
	if (!sourceName) {
		throw new Error(`Unknown source chain: ${source}`);
	}

	const destinationName = resolveChainAlias(destination, chainsData);
	if (!destinationName) {
		throw new Error(`Unknown destination chain: ${destination}`);
	}

	const links = files
		.flatMap((file) => mapRegistryFile(file, sourceName, destinationName, chainsData))
		.sort(compareLinks);

	return {
		source: {
			name: sourceName,
			chainId: chainIdFor(sourceName, chainsData),
		},
		destination: {
			name: destinationName,
			chainId: chainIdFor(destinationName, chainsData),
		},
		links,
	};
}

function isCandidateIbcFile(
	fileName: string,
	sourceName: string,
	destinationName: string
): boolean {
	const baseName = fileName.replace(/\.json$/i, '').toLowerCase();
	const source = normalizeChainKey(sourceName);
	const destination = normalizeChainKey(destinationName);
	return baseName === `${source}-${destination}` || baseName === `${destination}-${source}`;
}

async function fetchJson<T>(url: string, fetchFn: typeof fetch): Promise<T> {
	const response = await fetchFn(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${url}`);
	}

	return (await response.json()) as T;
}

async function fetchIbcDirectory(
	fetchFn: typeof fetch,
	now: () => number
): Promise<GithubContent[]> {
	if (directoryCache && directoryCache.expiresAt > now()) {
		return directoryCache.files;
	}

	const contents = await fetchJson<GithubContent[]>(GITHUB_CONTENTS_URL, fetchFn);
	const files = contents.filter(
		(item) => item.type === 'file' && item.name.toLowerCase().endsWith('.json')
	);
	directoryCache = {
		files,
		expiresAt: now() + IBC_CACHE_TTL_MS,
	};
	return files;
}

async function fetchIbcFile(
	file: GithubContent,
	fetchFn: typeof fetch,
	now: () => number
): Promise<RegistryFileInput> {
	const cached = fileCache.get(file.name);
	if (cached && cached.expiresAt > now()) {
		return { name: file.name, data: cached.data };
	}

	const url = file.download_url || `${RAW_IBC_BASE_URL}/${encodeURIComponent(file.name)}`;
	const data = await fetchJson<IbcRegistryFile>(url, fetchFn);
	fileCache.set(file.name, {
		data,
		expiresAt: now() + IBC_CACHE_TTL_MS,
	});
	return { name: file.name, data };
}

export async function resolveIbcLinksFromChainRegistry({
	source,
	destination,
	chainsData,
	fetchFn = fetch,
	now = () => Date.now(),
}: ResolveFromRegistryOptions): Promise<IbcLinkResolutionResult> {
	const sourceName = resolveChainAlias(source, chainsData);
	if (!sourceName) {
		throw new Error(`Unknown source chain: ${source}`);
	}

	const destinationName = resolveChainAlias(destination, chainsData);
	if (!destinationName) {
		throw new Error(`Unknown destination chain: ${destination}`);
	}

	const directory = await fetchIbcDirectory(fetchFn, now);
	const candidates = directory.filter((file) =>
		isCandidateIbcFile(file.name, sourceName, destinationName)
	);
	const files = await Promise.all(candidates.map((file) => fetchIbcFile(file, fetchFn, now)));

	return resolveIbcLinksFromRegistryFiles({
		source: sourceName,
		destination: destinationName,
		chainsData,
		files,
	});
}

export function clearIbcLinkCaches(): void {
	directoryCache = null;
	fileCache.clear();
}
