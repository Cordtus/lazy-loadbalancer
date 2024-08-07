// crawler.ts
import dns from 'dns';
import pLimit from 'p-limit';
import { promisify } from 'util';
import config from './config.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { crawlerLogger as logger } from './logger.js';
import { differenceInSeconds, parseISO } from 'date-fns';
import fetch, { Response as FetchResponse } from 'node-fetch';
import { ChainEntry, NetInfo, StatusInfo, StatusResponse, Peer, BlacklistedIP } from './types';
import { loadChainsData, saveChainsData, loadRejectedIPs, saveRejectedIPs, loadGoodIPs, saveGoodIPs, loadBlacklistedIPs, saveBlacklistedIPs, loadPorts, savePorts } from './utils.js';

const ping = promisify(dns.lookup);

const MAX_FAILURES = 10;
const BLACKLIST_TIMEOUT = 30 * 60 * 1000; // 30 minutes

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string): Promise<FetchResponse> {
  const { timeout, retries, retryDelay } = config.crawler;
  let lastError: unknown;

  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (error: unknown) {
      lastError = error;
      if (error instanceof Error) {
        logger.warn(`Attempt ${i + 1} failed for ${url}: ${error.message}`);
        if (error.name === 'AbortError') {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          break; // If it's not a timeout, don't retry
        }
      } else {
        logger.warn(`Attempt ${i + 1} failed for ${url}: Unknown error`);
        break;
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  } else {
    throw new Error(`Failed to fetch ${url}: Unknown error`);
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
    return parsedUrl.toString().replace(/\/$/, '');
  } catch (error) {
    logger.error(`Failed to normalize URL: ${url}`, error);
    return null;
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

function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const firstOctet = parseInt(parts[0], 10);
  const secondOctet = parseInt(parts[1], 10);
  return (
    firstOctet === 10 ||
    (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (firstOctet === 192 && secondOctet === 168)
  );
}

function extractPeerInfo(peers: Peer[]): string[] {
  const ports = new Set<number>(loadPorts().filter((port): port is number => port !== null));
  const peerAddresses: string[] = [];

  peers.forEach(peer => {
    const extractIPAndPort = (address: string): { ip: string; port: number | null } => {
      const [ip, portStr] = address.split(':');
      const port = portStr ? parseInt(portStr, 10) : null;
      return { ip, port: isNaN(port!) ? null : port };
    };

    const addresses = [
      peer.node_info.listen_addr,
      peer.node_info.other.rpc_address,
      peer.remote_ip
    ].filter(Boolean);

    addresses.forEach(address => {
      const { ip, port } = extractIPAndPort(address);
      if (ip && !isPrivateIP(ip) && ip !== 'localhost' && ip !== '0.0.0.0' && port !== null) {
        ports.add(port);
        peerAddresses.push(`${ip}:${port}`);
      }
    });
  });

  // Save updated ports
  savePorts(Array.from(ports));

  return [...new Set(peerAddresses)]; // Remove duplicates
}

async function checkEndpoint(url: string, expectedChainId: string): Promise<{ isValid: boolean; actualChainId: string | null; url: string; peers: string[] }> {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    logger.error(`Invalid URL: ${url}`);
    return { isValid: false, actualChainId: null, url, peers: [] };
  }

  const parsedUrl = new URL(normalizedUrl);

  try {
    logger.debug(`Checking endpoint: ${normalizedUrl}`);
    
    const response = await fetchWithTimeout(`${normalizedUrl}/status`);
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

    const isHealthy = timeDifference <= 60 && txIndexOn; // 60 seconds = 1 minute
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

async function checkPeerEndpoints(peerAddresses: string[], expectedChainId: string): Promise<string[]> {
  const validEndpoints: string[] = [];
  const ports = loadPorts();
  const limit = pLimit(10); // Limit concurrent requests

  const domainChecks = peerAddresses.filter(addr => !addr.match(/^\d+\.\d+\.\d+\.\d+/));
  const ipChecks = peerAddresses.filter(addr => addr.match(/^\d+\.\d+\.\d+\.\d+/));

  const checkEndpointWithProtocolAndPort = async (address: string, protocol: string, port: number) => {
    const url = `${protocol}://${address.split(':')[0]}:${port}/status`;
    try {
      const response = await fetchWithTimeout(url);
      if (response.ok) {
        const data = await response.json() as StatusResponse;
        if (data.result.node_info.network === expectedChainId) {
          validEndpoints.push(url.replace('/status', ''));
          return true;
        }
      }
    } catch (error) {
      // Ignore errors
    }
    return false;
  };

  const checkSequence = async (addresses: string[], isIp: boolean) => {
    for (const address of addresses) {
      // Check with https and port 443
      if (await limit(() => checkEndpointWithProtocolAndPort(address, 'https', 443))) continue;

      // Check with https and port 26657, then http and 26657
      if (await limit(() => checkEndpointWithProtocolAndPort(address, 'https', 26657))) continue;
      if (await limit(() => checkEndpointWithProtocolAndPort(address, 'http', 26657))) continue;

      // Check remaining ports
      for (const port of ports) {
        if (port !== 443 && port !== 26657) {
          const protocol = isIp ? 'http' : 'https';
          if (await limit(() => checkEndpointWithProtocolAndPort(address, protocol, port))) break;
        }
      }
    }
  };

  await checkSequence(domainChecks, false);
  await checkSequence(ipChecks, true);

  return validEndpoints;
}

export async function crawlNetwork(chainName: string, initialRpcUrls: string[]): Promise<{
  newEndpoints: number,
  totalEndpoints: number,
  misplacedEndpoints: number
}> {
  let chainsData: Record<string, ChainEntry> = loadChainsData();
  const checkedUrls: Set<string> = new Set<string>();
  let rejectedIPs = new Set(loadRejectedIPs());
  let goodIPs: Record<string, number> = {};
  const loadedGoodIPs = loadGoodIPs();
  for (const [ip, isGood] of Object.entries(loadedGoodIPs)) {
    goodIPs[ip] = isGood ? Date.now() : 0;
  }
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
  const circuitBreakers: Record<string, CircuitBreaker> = {};

  try {
    while ((urlsToCheck.size > 0 || discoveredPeers.size > 0) && (Date.now() - startTime < timeLimit)) {
      const currentBatch = [...urlsToCheck, ...discoveredPeers].slice(0, 50)
        .filter(url => !processedUrls.has(url));
      urlsToCheck = new Set([...urlsToCheck].filter(url => !currentBatch.includes(url)));
      discoveredPeers = new Set([...discoveredPeers].filter(url => !currentBatch.includes(url)));

      const checkPromises = currentBatch.map(url => 
        limit(() => {
          if (!circuitBreakers[url]) {
            circuitBreakers[url] = new CircuitBreaker();
          }
          if (circuitBreakers[url].isOpen()) {
            return { isValid: false, actualChainId: null, url, peers: [] };
          }
          return checkEndpoint(url, expectedChainId);
        })
      );

      const results = await Promise.all(checkPromises);

      for (const result of results) {
        if (result.isValid) {
          circuitBreakers[result.url].recordSuccess();
          if (result.actualChainId === expectedChainId) {
            if (!chainsData[chainName]['rpc-addresses'].includes(result.url)) {
              chainsData[chainName]['rpc-addresses'].push(result.url);
              newEndpointsCount++;
              logger.info(`Added new RPC endpoint for ${chainName}: ${result.url}`);
            }
            goodIPs[new URL(result.url).hostname] = Date.now();
          } else if (result.actualChainId && chainsData[result.actualChainId]) {
            if (!chainsData[result.actualChainId]['rpc-addresses'].includes(result.url)) {
              chainsData[result.actualChainId]['rpc-addresses'].push(result.url);
              misplacedEndpointsCount++;
              logger.info(`Added misplaced RPC endpoint: ${result.url} to ${result.actualChainId}`);
            }
          }

          // Process discovered peers
          const validPeerEndpoints = await checkPeerEndpoints(result.peers, expectedChainId);
          for (const peerEndpoint of validPeerEndpoints) {
            if (!checkedUrls.has(peerEndpoint)) {
              discoveredPeers.add(peerEndpoint);
            }
          }
        } else {
          circuitBreakers[result.url].recordFailure();
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