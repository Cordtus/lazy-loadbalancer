import fetch, { Response as FetchResponse } from 'node-fetch';
import { ChainEntry, NetInfo, StatusInfo, Peer } from './types';
import { loadChainsData, saveChainsData, loadRejectedIPs, saveRejectedIPs, loadGoodIPs, saveGoodIPs } from './utils.js';
import config from './config.js';
import dns from 'dns';
import { promisify } from 'util';
import logger from './logger.js';

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
    const response = await fetchWithTimeout(`${url}/net_info`);
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

  // Initial population of toCheck
  for (const url of initialRpcUrls) {
    const netInfo = await fetchNetInfo(url);
    if (netInfo) {
      toCheck.push(...extractPeerInfo(netInfo.peers));
    }
  }

  for (let round = 0; round < 5; round++) {
    logger.info(`Starting round ${round + 1} of crawling for ${chainName}`);
    const newPeers: PeerInfo[] = [];

    // Batch IP validation
    const validIps = (await Promise.all(
      toCheck.flatMap(peer => peer.ips.map(async ip => ({ ip, valid: await isValidIp(ip) })))
    )).filter(result => result.valid).map(result => result.ip);

    // Batch port checking
    for (const port of COMMON_PORTS) {
      const batchResults = await Promise.all(
        validIps.map(async ip => {
          const url = `http${port === 443 ? 's' : ''}://${ip}:${port}`;
          if (checked.has(url)) return null;
          checked.add(url);
          
          const isValid = await checkEndpoint(url);
          if (isValid) {
            if (!chainsData[chainName]['rpc-addresses'].includes(url)) {
              chainsData[chainName]['rpc-addresses'].push(url);
              goodIPs[ip] = Date.now();
              logger.info(`Added new RPC endpoint: ${url}`);
            }
            const netInfo = await fetchNetInfo(url);
            if (netInfo) {
              newPeers.push(...extractPeerInfo(netInfo.peers));
            }
            return url;
          }
          return null;
        })
      );

      // Update chainsData and goodIPs
      batchResults.filter(Boolean).forEach(url => {
        if (url && !chainsData[chainName]['rpc-addresses'].includes(url)) {
          chainsData[chainName]['rpc-addresses'].push(url);
          const ip = normalizeUrl(url);
          goodIPs[ip] = Date.now();
        }
      });
    }

    // Prepare for next round
    toCheck = newPeers.filter(peer => !checked.has(peer.id));
    if (toCheck.length === 0) break;
  }

  saveChainsData(chainsData);
  saveGoodIPs(goodIPs);
  saveRejectedIPs(rejectedIPs);
}

async function startCrawling(): Promise<void> {
  const chainsData = loadChainsData();
  for (const [chainName, chainData] of Object.entries(chainsData)) {
    await crawlNetwork(chainName, chainData['rpc-addresses']);
  }
}

export { crawlNetwork, startCrawling };