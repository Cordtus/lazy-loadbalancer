import { differenceInSeconds, parseISO } from 'date-fns';
import fetch, { Response as FetchResponse } from 'node-fetch';
import { ChainEntry, NetInfo, StatusInfo, StatusResponse, Peer, BlacklistedIP } from './types';
import { loadChainsData, saveChainsData, loadRejectedIPs, saveRejectedIPs, loadGoodIPs, saveGoodIPs, loadBlacklistedIPs, saveBlacklistedIPs } from './utils.js';
import config from './config.js';
import dns from 'dns';
import pLimit from 'p-limit';
import { promisify } from 'util';
import { crawlerLogger, crawlerLogger as logger } from './logger.js';

const ping = promisify(dns.lookup);

const visitedNodes = new Set<string>();
let rejectedIPs = loadRejectedIPs();
let goodIPs: Record<string, boolean> = loadGoodIPs();
let blacklistedIPs: BlacklistedIP[] = loadBlacklistedIPs();

const COMMON_PORTS = [443, 2401, 10157, 15957, 14657, 22257, 26657, 26667, 27957, 31657, 33657, 36657, 37657, 46657, 53657, 56657, 58657];
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

function isGoodIP(hostname: string): boolean {
  return !!goodIPs[hostname];
}

function addToGoodIPs(hostname: string): void {
  goodIPs[hostname] = true;
  saveGoodIPs(goodIPs);
}

function addToBlacklist(ip: string): void {
  const existingEntry = blacklistedIPs.find(entry => entry.ip === ip);
  if (existingEntry) {
    existingEntry.failureCount = (existingEntry.failureCount || 0) + 1;
    existingEntry.timestamp = Date.now();
  } else {
    blacklistedIPs.push({ ip, failureCount: 1, timestamp: Date.now() });
  }
  saveBlacklistedIPs(blacklistedIPs);
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

function extractPeerInfo(peers: Peer[]): string[] {
  return peers.flatMap(peer => {
    const ips = [
      normalizeUrl(peer.node_info.listen_addr),
      normalizeUrl(peer.remote_ip),
      normalizeUrl(peer.node_info.other.rpc_address)
    ].filter(ip => 
      ip && 
      ip !== '127.0.0.1' && 
      ip !== '0.0.0.0' && 
      !ip.includes(':') // Exclude IPv6
    );
    return ips;
  });
}

function isBlacklisted(ip: string): boolean {
  return blacklistedIPs.some(entry => entry.ip === ip);
}

async function checkEndpoint(url: string, expectedChainId: string): Promise<{ isValid: boolean; actualChainId: string | null; url: string; peers: string[] }> {
  try {
    logger.debug(`Checking endpoint: ${url}`);
    
    const response = await fetchWithTimeout(`${url}/status`);
    if (!response.ok) {
      logger.debug(`${url} returned non-OK status: ${response.status}`);
      return { isValid: false, actualChainId: null, url, peers: [] };
    }
    
    const data = await response.json() as StatusResponse;
    const { result } = data;

    const actualChainId = result.node_info.network;
    const txIndexOn = result.node_info.other.tx_index === "on";
    logger.debug(`${url} returned chain ID: ${actualChainId}, tx_index: ${txIndexOn ? "on" : "off"}`);
    
    const latestBlockTime = parseISO(result.sync_info.latest_block_time);
    const currentTime = new Date();
    const timeDifference = Math.abs(differenceInSeconds(latestBlockTime, currentTime));

    const isHealthy = timeDifference <= 60; // 60 seconds = 1 minute
    logger.debug(`${url} health check: ${isHealthy ? 'Passed' : 'Failed'} (${timeDifference}s behind)`);

    let peers: string[] = [];
    if (isHealthy) {
      const netInfo = await fetchNetInfo(url);
      if (netInfo) {
        peers = extractPeerInfo(netInfo.peers);
        logger.debug(`${url} returned ${peers.length} peers`);
      }
    }

    return { 
      isValid: isHealthy,
      actualChainId,
      url,
      peers,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    logger.error(`Error checking ${url}: ${errorMessage}`);
    return { isValid: false, actualChainId: null, url, peers: [] };
  }
}

export async function crawlNetwork(chainName: string, initialRpcUrls: string[]): Promise<{
  newEndpoints: number,
  totalEndpoints: number,
  misplacedEndpoints: number
}> {
  let chainsData: Record<string, ChainEntry> = loadChainsData();
  const checkedUrls = new Set<string>();
  const rejectedIPs = new Set(loadRejectedIPs());
  const goodIPs = new Set(Object.keys(loadGoodIPs()));
  const blacklistedIPs = new Set(loadBlacklistedIPs().map(item => item.ip));

  let newEndpointsCount = 0;
  let misplacedEndpointsCount = 0;

  const expectedChainId = chainsData[chainName]['chain-id'];

  logger.info(`Starting crawl for chain ${chainName} with ${initialRpcUrls.length} initial RPC URLs`);

  let urlsToCheck = new Set(initialRpcUrls);
  let discoveredPeers = new Set<string>();

  while (urlsToCheck.size > 0 || discoveredPeers.size > 0) {
    if (urlsToCheck.size > 0) {
      const batchSize = Math.min(50, urlsToCheck.size);
      const batch = Array.from(urlsToCheck).slice(0, batchSize);
      batch.forEach(url => urlsToCheck.delete(url));

      const results = await Promise.allSettled(batch.map(url => checkEndpoint(url, expectedChainId)));

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { url, isValid, actualChainId, peers } = result.value;
          try {
            if (!checkedUrls.has(url)) {
              checkedUrls.add(url);
              const ip = new URL(url).hostname;
              
              if (isValid) {
                if (actualChainId === expectedChainId) {
                  if (!chainsData[chainName]['rpc-addresses'].includes(url)) {
                    chainsData[chainName]['rpc-addresses'].push(url);
                    newEndpointsCount++;
                    logger.info(`Added new RPC endpoint for ${chainName}: ${url}`);
                  }
                  // Process peers for the current chain
                  peers.forEach(peer => {
                    if (!checkedUrls.has(peer) && !rejectedIPs.has(peer) && !blacklistedIPs.has(peer) && !goodIPs.has(peer)) {
                      discoveredPeers.add(peer);
                    }
                  });
                } else if (actualChainId && chainsData[actualChainId]) {
                  if (!chainsData[actualChainId]['rpc-addresses'].includes(url)) {
                    chainsData[actualChainId]['rpc-addresses'].push(url);
                    misplacedEndpointsCount++;
                    logger.info(`Added misplaced RPC endpoint: ${url} to ${actualChainId}`);
                  }
                }
                goodIPs.add(ip);
              } else {
                rejectedIPs.add(ip);
              }
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
            logger.warn(`Error processing URL: ${url}. Error: ${errorMessage}`);
          }
        } else {
          logger.warn(`Failed to check endpoint: ${result.reason}`);
        }
      }
    }
    
    // Process discovered peers
    if (discoveredPeers.size > 0) {
      const peersToProcess = Array.from(discoveredPeers);
      discoveredPeers.clear();
      for (const peer of peersToProcess) {
        for (const port of COMMON_PORTS) {
          const peerUrl = `http://${peer}:${port}`;
          if (!checkedUrls.has(peerUrl)) {
            urlsToCheck.add(peerUrl);
            checkedUrls.add(peerUrl);
          }
        }
      }
    }

    // Periodically save data
    if (newEndpointsCount % 10 === 0) {
      saveChainsData(chainsData);
      saveGoodIPs(Object.fromEntries([...goodIPs].map(ip => [ip, true])));
      saveRejectedIPs([...rejectedIPs]);
    }
  }

  // Final save
  saveChainsData(chainsData);
  saveGoodIPs(Object.fromEntries([...goodIPs].map(ip => [ip, true])));
  saveRejectedIPs([...rejectedIPs]);
    
  logger.info(`Crawl for ${chainName} finished. Total RPC endpoints: ${chainsData[chainName]['rpc-addresses'].length}`);
    
  return {
    newEndpoints: newEndpointsCount,
    totalEndpoints: chainsData[chainName]['rpc-addresses'].length,
    misplacedEndpoints: misplacedEndpointsCount
  };
}

export async function crawlAllChains(): Promise<Record<string, { newEndpoints: number, totalEndpoints: number, misplacedEndpoints: number }>> {
  const chainsData = loadChainsData();
  const totalChains = Object.keys(chainsData).length;
  logger.info(`Starting to crawl all chains. Total chains: ${totalChains}`);

  const results: Record<string, { newEndpoints: number, totalEndpoints: number, misplacedEndpoints: number }> = {};
  
  // Limit concurrency to 5 chains at a time
  const limit = pLimit(5);

  const crawlPromises = Object.entries(chainsData).map(([chainName, chainData], index) => 
    limit(async () => {
      logger.info(`Crawling chain ${index + 1}/${totalChains}: ${chainName}`);
      try {
        if (!chainData || !chainData['rpc-addresses'] || !Array.isArray(chainData['rpc-addresses'])) {
          logger.error(`Invalid chain data for ${chainName}`, { chainData });
          return;
        }

        results[chainName] = await crawlNetwork(chainName, chainData['rpc-addresses']);
        
        logger.info(`Finished crawling chain ${index + 1}/${totalChains}: ${chainName}`);
      } catch (error) {
        logger.error(`Error crawling chain ${chainName}:`, error);
      }
    })
  );

  await Promise.all(crawlPromises);

  // Save data after all chains are completed
  saveChainsData(chainsData);
  saveGoodIPs(goodIPs);
  saveRejectedIPs(rejectedIPs);

  logger.info('Finished crawling all chains');
  return results;
}