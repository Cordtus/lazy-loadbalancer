import { differenceInSeconds, parseISO } from 'date-fns';
import fetch, { Response as FetchResponse } from 'node-fetch';
import { ChainEntry, NetInfo, StatusInfo, StatusResponse, Peer } from './types';
import { loadChainsData, saveChainsData, loadRejectedIPs, saveRejectedIPs, loadGoodIPs, saveGoodIPs, loadBlacklistedIPs } from './utils.js';
import config from './config.js';
import dns from 'dns';
import pLimit from 'p-limit';
import { promisify } from 'util';
import { crawlerLogger as logger } from './logger.js';

const ping = promisify(dns.lookup);

const visitedNodes = new Set<string>();
let rejectedIPs = loadRejectedIPs();
let goodIPs = loadGoodIPs();

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

async function checkEndpoint(url: string, expectedChainId: string): Promise<{ isValid: boolean; actualChainId: string | null; url: string; peers: string[] }> {
  try {
    const response = await fetchWithTimeout(`${url}/status`);
    if (!response.ok) {
      rejectedIPs.add(new URL(url).hostname);
      return { isValid: false, actualChainId: null, url, peers: [] };
    }
    
    const data = await response.json() as StatusResponse;
    const { result } = data;

    const actualChainId = result.node_info.network;
    
    const latestBlockTime = parseISO(result.sync_info.latest_block_time);
    const currentTime = new Date();
    const timeDifference = Math.abs(differenceInSeconds(latestBlockTime, currentTime));

    const isHealthy = timeDifference <= 60; // 60 seconds = 1 minute

    if (!isHealthy) {
      rejectedIPs.add(new URL(url).hostname);
    }

    let peers: string[] = [];
    if (isHealthy) {
      const netInfo = await fetchNetInfo(url);
      if (netInfo) {
        peers = extractPeerInfo(netInfo.peers).flatMap(peer => peer.ips);
      }
    }

    return { 
      isValid: isHealthy && actualChainId === expectedChainId,
      actualChainId,
      url,
      peers
    };
  } catch {
    rejectedIPs.add(new URL(url).hostname);
    return { isValid: false, actualChainId: null, url, peers: [] };
  }
}

async function crawlNetwork(chainName: string, initialRpcUrls: string[]): Promise<{
  newEndpoints: number,
  totalEndpoints: number,
  misplacedEndpoints: number
}> {
  let chainsData = loadChainsData();
  const blacklistedIPs = new Set(loadBlacklistedIPs());
  const checkedUrls = new Set<string>();

  let newEndpointsCount = 0;
  let misplacedEndpointsCount = 0;

  const expectedChainId = chainsData[chainName]['chain-id'];

  logger.info(`Starting crawl for chain ${chainName} with ${initialRpcUrls.length} initial RPC URLs`);

  let urlsToCheck = new Set(initialRpcUrls);
  let discoveredPeers = new Set<string>();

  while (urlsToCheck.size > 0 || discoveredPeers.size > 0) {
    // Check known RPC URLs
    if (urlsToCheck.size > 0) {
      const batchSize = Math.min(50, urlsToCheck.size);
      const batch = Array.from(urlsToCheck).slice(0, batchSize);
      batch.forEach(url => urlsToCheck.delete(url));

      const results = await Promise.all(batch.map(url => checkEndpoint(url, expectedChainId)));

      for (const result of results) {
        if (result.isValid) {
          if (!chainsData[chainName]['rpc-addresses'].includes(result.url)) {
            chainsData[chainName]['rpc-addresses'].push(result.url);
            newEndpointsCount++;
            logger.info(`Added new RPC endpoint: ${result.url}`);
          }
          result.peers.forEach(peer => {
            if (!checkedUrls.has(peer) && !blacklistedIPs.has(peer)) {
              discoveredPeers.add(peer);
            }
          });
        } else if (result.actualChainId && result.actualChainId !== expectedChainId) {
          if (chainsData[result.actualChainId] && !chainsData[result.actualChainId]['rpc-addresses'].includes(result.url)) {
            chainsData[result.actualChainId]['rpc-addresses'].push(result.url);
            misplacedEndpointsCount++;
            logger.info(`Added misplaced RPC endpoint: ${result.url} to ${result.actualChainId}`);
          }
        }
        checkedUrls.add(result.url);
      }
    }

    // Check discovered peers for each port
    if (discoveredPeers.size > 0) {
      for (const port of COMMON_PORTS) {
        const peerBatch = Array.from(discoveredPeers).slice(0, 50);  // Check up to 50 peers per port
        const urlsToTry = peerBatch.map(peer => `http://${peer}:${port}`);
        
        const results = await Promise.all(urlsToTry.map(url => checkEndpoint(url, expectedChainId)));

        for (const result of results) {
          if (result.isValid) {
            if (!chainsData[chainName]['rpc-addresses'].includes(result.url)) {
              chainsData[chainName]['rpc-addresses'].push(result.url);
              newEndpointsCount++;
              logger.info(`Added new RPC endpoint: ${result.url}`);
            }
            result.peers.forEach(peer => {
              if (!checkedUrls.has(peer) && !blacklistedIPs.has(peer)) {
                discoveredPeers.add(peer);
              }
            });
          } else if (result.actualChainId && result.actualChainId !== expectedChainId) {
            if (chainsData[result.actualChainId] && !chainsData[result.actualChainId]['rpc-addresses'].includes(result.url)) {
              chainsData[result.actualChainId]['rpc-addresses'].push(result.url);
              misplacedEndpointsCount++;
              logger.info(`Added misplaced RPC endpoint: ${result.url} to ${result.actualChainId}`);
            }
          }
          checkedUrls.add(result.url);
        }

        peerBatch.forEach(peer => discoveredPeers.delete(peer));
      }
    }

    // Save data periodically
    if ((urlsToCheck.size + discoveredPeers.size) % 100 === 0) {
      saveChainsData(chainsData);
    }
  }

  // Final save
  saveChainsData(chainsData);
  saveGoodIPs(goodIPs);
  saveRejectedIPs(rejectedIPs);

  logger.info(`Crawl for ${chainName} finished. Total RPC endpoints: ${chainsData[chainName]['rpc-addresses'].length}`);

  return {
    newEndpoints: newEndpointsCount,
    totalEndpoints: chainsData[chainName]['rpc-addresses'].length,
    misplacedEndpoints: misplacedEndpointsCount
  };
}

async function crawlAllChains(): Promise<Record<string, { newEndpoints: number, totalEndpoints: number, misplacedEndpoints: number }>> {
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

export { crawlNetwork, crawlAllChains };