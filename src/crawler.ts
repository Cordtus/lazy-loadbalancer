import { differenceInSeconds, parseISO } from 'date-fns';
import fetch, { Response as FetchResponse } from 'node-fetch';
import { ChainEntry, NetInfo, StatusInfo, StatusResponse, Peer, BlacklistedIP } from './types';
import { loadChainsData, saveChainsData, loadRejectedIPs, saveRejectedIPs, loadGoodIPs, saveGoodIPs, loadBlacklistedIPs, saveBlacklistedIPs } from './utils.js';
import config from './config.js';
import dns from 'dns';
import pLimit from 'p-limit';
import { promisify } from 'util';
import { crawlerLogger as logger } from './logger.js';

const ping = promisify(dns.lookup);

const COMMON_PORTS = [443, 26657, 36657, 22257, 14657, 58657, 33657, 53657, 37657, 31657, 10157, 27957, 2401, 15957, 80, 8080, 8000];
const MAX_FAILURES = 10;
const BLACKLIST_TIMEOUT = 30 * 60 * 1000; // 30 minutes

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

function normalizeUrl(url: string): string | null {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname.includes('/')) {
      const parts = parsedUrl.hostname.split('/');
      parsedUrl.hostname = parts[0];
      parsedUrl.pathname = '/' + parts.slice(1).join('/') + parsedUrl.pathname;
    }
    if (!parsedUrl.port && !COMMON_PORTS.includes(parseInt(parsedUrl.port))) {
      parsedUrl.port = '';
    }
    return parsedUrl.toString().replace(/\/$/, '');
  } catch (error) {
    logger.error(`Failed to normalize URL: ${url}`, error);
    return null;
  }
}

async function isSecure(url: string): Promise<boolean> {
  try {
    await fetch(`https://${url}/status`);
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

function extractPeerInfo(peers: Peer[]): string[] {
  return peers.flatMap(peer => {
    const ips = [
      peer.node_info.listen_addr,
      peer.remote_ip,
      peer.node_info.other.rpc_address
    ]
    .map(ip => {
      if (ip.startsWith('tcp://')) {
        return ip.replace('tcp://', 'http://');
      }
      return ip;
    })
    .filter(ip => 
      ip && 
      !ip.includes('127.0.0.1') && 
      !ip.includes('0.0.0.0') && 
      !ip.includes('[') // Exclude IPv6
    )
    .map(normalizeUrl)
    .filter((ip): ip is string => ip !== null);
    
    return [...new Set(ips)]; // Remove duplicates
  });
}

async function checkEndpoint(url: string, expectedChainId: string): Promise<{ isValid: boolean; actualChainId: string | null; url: string; peers: string[] }> {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    logger.error(`Invalid URL: ${url}`);
    return { isValid: false, actualChainId: null, url, peers: [] };
  }

  const parsedUrl = new URL(normalizedUrl);
  const isHttps = parsedUrl.protocol === 'https:' || parsedUrl.port === '443' || !parsedUrl.port;

  try {
    logger.debug(`Checking endpoint: ${normalizedUrl}`);
    
    const response = await fetchWithTimeout(`${isHttps ? 'https' : 'http'}://${parsedUrl.host}/status`);
    if (!response.ok) {
      logger.debug(`${normalizedUrl} returned non-OK status: ${response.status}`);
      return { isValid: false, actualChainId: null, url: normalizedUrl, peers: [] };
    }
    
    const data = await response.json() as StatusResponse;
    const { result } = data;

    const actualChainId = result.node_info.network;
    const txIndexOn = result.node_info.other.tx_index === "on";
    logger.debug(`${normalizedUrl} returned chain ID: ${actualChainId}, tx_index: ${txIndexOn ? "on" : "off"}`);
    
    const latestBlockTime = parseISO(result.sync_info.latest_block_time);
    const currentTime = new Date();
    const timeDifference = Math.abs(differenceInSeconds(latestBlockTime, currentTime));

    const isHealthy = timeDifference <= 60; // 60 seconds = 1 minute
    logger.debug(`${normalizedUrl} health check: ${isHealthy ? 'Passed' : 'Failed'} (${timeDifference}s behind)`);

    let peers: string[] = [];
    if (isHealthy) {
      const netInfo = await fetchNetInfo(normalizedUrl);
      if (netInfo) {
        peers = extractPeerInfo(netInfo.peers);
        logger.debug(`${normalizedUrl} returned ${peers.length} peers`);
      }
    }

    return { 
      isValid: isHealthy,
      actualChainId,
      url: normalizedUrl,
      peers,
    };
  } catch (error) {
    logger.error(`Error checking ${normalizedUrl}:`, error);
    return { isValid: false, actualChainId: null, url: normalizedUrl, peers: [] };
  }
}

export async function crawlNetwork(chainName: string, initialRpcUrls: string[]): Promise<{
  newEndpoints: number,
  totalEndpoints: number,
  misplacedEndpoints: number
}> {
  let chainsData: Record<string, ChainEntry> = loadChainsData();
  const checkedUrls: Set<string> = new Set<string>();
  let rejectedIPs = new Set(loadRejectedIPs());
  let goodIPs: Record<string, boolean> = loadGoodIPs();
  let blacklistedIPs = loadBlacklistedIPs();
  let newEndpointsCount = 0;
  let misplacedEndpointsCount = 0;

  const expectedChainId: string = chainsData[chainName]['chain-id'];
  const startTime = Date.now();
  const timeLimit = 5 * 60 * 1000; // 5 minutes in milliseconds

  logger.info(`Starting crawl for chain ${chainName} with ${initialRpcUrls.length} initial RPC URLs`);

  let urlsToCheck: Set<string> = new Set(initialRpcUrls.map(url => {
    const normalized = normalizeUrl(url);
    return normalized && isValidUrl(normalized) ? normalized : null;
  }).filter((url): url is string => url !== null));
  let discoveredPeers: Set<string> = new Set<string>();

  const limit = pLimit(5); // Limit concurrent requests
  const processedUrls = new Set<string>();

  try {
    while ((urlsToCheck.size > 0 || discoveredPeers.size > 0) && (Date.now() - startTime < timeLimit)) {
      const currentBatch = [...urlsToCheck, ...discoveredPeers].slice(0, 50)
        .filter(url => !processedUrls.has(url));
      urlsToCheck = new Set([...urlsToCheck].filter(url => !currentBatch.includes(url)));
      discoveredPeers = new Set([...discoveredPeers].filter(url => !currentBatch.includes(url)));

      const checkPromises = currentBatch.map(url => 
        limit(() => checkEndpoint(url, expectedChainId))
      );

      const results = await Promise.all(checkPromises);

      for (const result of results) {
        if (result.isValid) {
          if (result.actualChainId === expectedChainId) {
            if (!chainsData[chainName]['rpc-addresses'].includes(result.url)) {
              chainsData[chainName]['rpc-addresses'].push(result.url);
              newEndpointsCount++;
              logger.info(`Added new RPC endpoint for ${chainName}: ${result.url}`);
            }
            goodIPs[new URL(result.url).hostname] = true;
          } else if (result.actualChainId && chainsData[result.actualChainId]) {
            if (!chainsData[result.actualChainId]['rpc-addresses'].includes(result.url)) {
              chainsData[result.actualChainId]['rpc-addresses'].push(result.url);
              misplacedEndpointsCount++;
              logger.info(`Added misplaced RPC endpoint: ${result.url} to ${result.actualChainId}`);
            }
          }

          // Process discovered peers
          for (const peer of result.peers) {
            const peerUrl = new URL(peer);
            if (!checkedUrls.has(peer) && !rejectedIPs.has(peerUrl.hostname) && !blacklistedIPs.some(item => item.ip === peerUrl.hostname)) {
              if (peerUrl.protocol === 'https:' || peerUrl.port === '443') {
                discoveredPeers.add(peer);
              } else {
                discoveredPeers.add(`http://${peerUrl.hostname}:${peerUrl.port || '26657'}`);
              }
            }
          }
        } else {
          const hostname = new URL(result.url).hostname;
          const blacklistedEntry = blacklistedIPs.find(item => item.ip === hostname);
          if (blacklistedEntry) {
            blacklistedEntry.failureCount = (blacklistedEntry.failureCount || 0) + 1;
            blacklistedEntry.timestamp = Date.now();
            if (blacklistedEntry.failureCount >= MAX_FAILURES) {
              rejectedIPs.add(hostname);
            }
          } else {
            blacklistedIPs.push({ ip: hostname, failureCount: 1, timestamp: Date.now() });
          }
        }
        processedUrls.add(result.url);
      }

      // Save data periodically
      if (newEndpointsCount % 10 === 0) {
        saveChainsData(chainsData);
        saveGoodIPs(goodIPs);
        saveRejectedIPs([...rejectedIPs]);
        saveBlacklistedIPs(blacklistedIPs);
      }
    }
  } catch (error) {
    logger.error(`Unexpected error during crawl for ${chainName}:`, error);
  } finally {
    // Final save
    saveChainsData(chainsData);
    saveGoodIPs(goodIPs);
    saveRejectedIPs([...rejectedIPs]);
    saveBlacklistedIPs(blacklistedIPs);
  }

  logger.info(`Crawl for ${chainName} finished. Total RPC endpoints: ${chainsData[chainName]['rpc-addresses'].length}`);
    
  return {
    newEndpoints: newEndpointsCount,
    totalEndpoints: chainsData[chainName]['rpc-addresses'].length,
    misplacedEndpoints: misplacedEndpointsCount
  };
}

export async function crawlAllChains(): Promise<Record<string, { newEndpoints: number, totalEndpoints: number, misplacedEndpoints: number }>> {
  const chainsData = loadChainsData();
  const results: Record<string, { newEndpoints: number, totalEndpoints: number, misplacedEndpoints: number }> = {};
  
  const limit = pLimit(5);

  const crawlPromises = Object.entries(chainsData).map(([chainName, chainData]) => 
    limit(async () => {
      logger.info(`Crawling chain: ${chainName}`);
      try {
        if (!chainData || !chainData['rpc-addresses'] || !Array.isArray(chainData['rpc-addresses'])) {
          logger.error(`Invalid chain data for ${chainName}`, { chainData });
          return;
        }

        results[chainName] = await crawlNetwork(chainName, chainData['rpc-addresses']);
        
        logger.info(`Finished crawling chain: ${chainName}`);
      } catch (error) {
        logger.error(`Error crawling chain ${chainName}:`, error);
      }
    })
  );

  await Promise.all(crawlPromises);

  logger.info('Finished crawling all chains');
  return results;
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function cleanupBlacklist(): void {
  const now = Date.now();
  const blacklistedIPs = loadBlacklistedIPs();
  const updatedBlacklist = blacklistedIPs.filter(entry => 
    now - entry.timestamp < BLACKLIST_TIMEOUT || entry.failureCount < MAX_FAILURES
  );
  saveBlacklistedIPs(updatedBlacklist);
}