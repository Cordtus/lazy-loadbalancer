import fetch, { Response as FetchResponse } from 'node-fetch';
import { ChainEntry, NetInfo, StatusInfo, Peer } from './types';
import { loadChainsData, saveChainsData, loadRejectedIPs, saveRejectedIPs, loadGoodIPs, saveGoodIPs, loadBlacklistedIPs } from './utils.js';
import config from './config.js';
import dns from 'dns';
import { promisify } from 'util';
import { crawlerLogger as logger } from './logger.js';

const ping = promisify(dns.lookup);

const visitedNodes = new Set<string>();
const rejectedIPs = loadRejectedIPs();
const goodIPs = loadGoodIPs();

const COMMON_PORTS = [443, 26657, 36657, 46657, 56657];

interface PeerInfo {
  id: string;
  moniker: string;
  ips: string[];
}

async function fetchWithTimeout(url: string): Promise<FetchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.crawler.timeout);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/^(https?:\/\/)?(.*?)(:\d+)?\/?$/, '$2');
}

async function isValidIp(ip: string): Promise<boolean> {
  try {
    await ping(ip);
    return true;
  } catch {
    return false;
  }
}

async function fetchNetInfo(url: string): Promise<NetInfo | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // Increase timeout to 10 seconds

    const response = await fetch(`${url}/net_info`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const data = await response.json() as { result: NetInfo };
    return data.result;
  } catch (error) {
    logger.error(`Error fetching net_info from ${url}:`, error);
    return null;
  }
}

function extractPeerInfo(peers: Peer[]): PeerInfo[] {
  return peers.map(peer => ({
    id: peer.node_info.id,
    moniker: peer.node_info.moniker,
    ips: [
      normalizeUrl(peer.node_info.listen_addr),
      normalizeUrl(peer.remote_ip),
      normalizeUrl(peer.node_info.other.rpc_address)
    ].filter(ip => 
      ip && 
      ip !== '127.0.0.1' && 
      ip !== '0.0.0.0' && 
      !ip.includes(':') // Exclude IPv6
    )
  })).filter(peer => peer.ips.length > 0);
}

async function checkEndpoint(url: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${url}/status`);
    if (!response.ok) return false;
    const data = await response.json() as { result: { node_info: { other: { tx_index: string } } } };
    return data.result.node_info.other.tx_index === 'on';
  } catch {
    return false;
  }
}

async function crawlNetwork(chainName: string, initialRpcUrls: string[]): Promise<void> {
  const chainsData = loadChainsData();
  let toCheck: PeerInfo[] = [];
  const checked = new Set<string>();
  const blacklistedIPs = new Set(loadBlacklistedIPs());

  logger.info(`Starting crawl for chain ${chainName} with ${initialRpcUrls.length} initial RPC URLs`);

  // Initial population of toCheck
  for (const url of initialRpcUrls) {
    logger.debug(`Fetching net_info from initial URL: ${url}`);
    try {
      const netInfo = await fetchNetInfo(url);
      if (netInfo) {
        const peers = extractPeerInfo(netInfo.peers);
        logger.info(`Found ${peers.length} peers from ${url}`);
        toCheck.push(...peers);
      } else {
        logger.warn(`Failed to fetch net_info from ${url}`);
      }
    } catch (error) {
      logger.error(`Error fetching net_info from ${url}:`, error);
    }
  }

  if (toCheck.length === 0) {
    logger.warn(`No peers found for chain ${chainName}. Skipping crawl.`);
    return;
  }

  saveChainsData(chainsData);
  saveGoodIPs(goodIPs);
  saveRejectedIPs(rejectedIPs);
  logger.info(`Crawl for ${chainName} finished. Total RPC endpoints: ${chainsData[chainName]['rpc-addresses'].length}`);
}

async function startCrawling(): Promise<void> {
  const chainsData = loadChainsData();
  const totalChains = Object.keys(chainsData).length;
  logger.info(`Starting to crawl all chains. Total chains: ${totalChains}`);

  for (const [index, [chainName, chainData]] of Object.entries(chainsData).entries()) {
    logger.info(`Crawling chain ${index + 1}/${totalChains}: ${chainName}`);
    try {
      if (!chainData || !chainData['rpc-addresses'] || !Array.isArray(chainData['rpc-addresses'])) {
        logger.error(`Invalid chain data for ${chainName}`, { chainData });
        continue;
      }

      await crawlNetwork(chainName, chainData['rpc-addresses']);
      logger.info(`Finished crawling chain ${index + 1}/${totalChains}: ${chainName}`);
    } catch (error) {
      logger.error(`Error crawling chain ${chainName}:`, error);
      // Continue with the next chain instead of throwing
    }
  }

  logger.info('Finished crawling all chains');
}

export { crawlNetwork, startCrawling };