import { differenceInSeconds, parseISO } from 'date-fns';
import fetch, { Response as FetchResponse } from 'node-fetch';
import { ChainEntry, NetInfo, StatusInfo, StatusResponse, Peer } from './types';
import { loadChainsData, saveChainsData, loadRejectedIPs, saveRejectedIPs, loadGoodIPs, saveGoodIPs, loadBlacklistedIPs } from './utils.js';
import config from './config.js';
import dns from 'dns';
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

async function checkEndpoint(url: string, expectedChainId: string): Promise<{ isValid: boolean; actualChainId: string | null }> {
  try {
    const response = await fetchWithTimeout(`${url}/status`);
    if (!response.ok) {
      rejectedIPs.add(new URL(url).hostname);
      return { isValid: false, actualChainId: null };
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

    return { 
      isValid: isHealthy && actualChainId === expectedChainId,
      actualChainId
    };
  } catch {
    rejectedIPs.add(new URL(url).hostname);
    return { isValid: false, actualChainId: null };
  }
}


async function crawlNetwork(chainName: string, initialRpcUrls: string[]): Promise<{
  newEndpoints: number,
  totalEndpoints: number,
  misplacedEndpoints: number
}> {
  let chainsData = loadChainsData();
  let toCheck: PeerInfo[] = [];
  const checked = new Set<string>();
  const blacklistedIPs = new Set(loadBlacklistedIPs());

  let newEndpointsCount = 0;
  let misplacedEndpointsCount = 0;

  const expectedChainId = chainsData[chainName]['chain-id'];

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
    return { 
      newEndpoints: 0, 
      totalEndpoints: initialRpcUrls.length,
      misplacedEndpoints: 0
    };
  }

  for (let round = 0; round < 5; round++) {
    logger.info(`Starting round ${round + 1} of crawling for ${chainName}. Peers to check: ${toCheck.length}`);

    // Batch IP validation
    logger.debug(`Validating ${toCheck.length * toCheck[0].ips.length} IPs`);
    const validIps = (await Promise.all(
      toCheck.flatMap(peer => peer.ips.map(async ip => ({ ip, valid: await isValidIp(ip) })))
    )).filter(result => result.valid && !blacklistedIPs.has(result.ip)).map(result => result.ip);

    logger.info(`Found ${validIps.length} valid IPs`);

    // Batch port checking
    for (const port of COMMON_PORTS) {
      logger.debug(`Checking port ${port} for ${validIps.length} IPs`);
      const batchResults = await Promise.all(
        validIps.map(async ip => {
          const url = `http${port === 443 ? 's' : ''}://${ip}:${port}`;
          if (checked.has(url)) return null;
          checked.add(url);
          
          const { isValid, actualChainId } = await checkEndpoint(url, expectedChainId);
          if (isValid) {
            logger.info(`Valid endpoint found: ${url}`);
            if (!chainsData[chainName]['rpc-addresses'].includes(url)) {
              chainsData[chainName]['rpc-addresses'].push(url);
              goodIPs[ip] = Date.now();
              logger.info(`Added new RPC endpoint: ${url}`);
              newEndpointsCount++;
            }
            const netInfo = await fetchNetInfo(url);
            if (netInfo) {
              const peers = extractPeerInfo(netInfo.peers);
              logger.debug(`Found ${peers.length} new peers from ${url}`);
              toCheck.push(...peers);
            }
            return url;
          } else if (actualChainId && actualChainId !== expectedChainId) {
            // Handle misplaced endpoint
            logger.warn(`Misplaced endpoint found: ${url} belongs to ${actualChainId}, not ${chainName}`);
            if (chainsData[actualChainId] && !chainsData[actualChainId]['rpc-addresses'].includes(url)) {
              chainsData[actualChainId]['rpc-addresses'].push(url);
              goodIPs[ip] = Date.now();
              logger.info(`Added misplaced RPC endpoint: ${url} to ${actualChainId}`);
              misplacedEndpointsCount++;
            }
          }
          return null;
        })
      );

      const validEndpoints = batchResults.filter(Boolean);
      logger.info(`Found ${validEndpoints.length} valid endpoints for port ${port}`);

      // Save data after each port check
      saveChainsData(chainsData);
      saveGoodIPs(goodIPs);
      saveRejectedIPs(rejectedIPs);
    }

    // Prepare for next round
    toCheck = toCheck.filter(peer => !checked.has(peer.id));
    logger.info(`Round ${round + 1} completed. Peers to check in next round: ${toCheck.length}`);

    if (toCheck.length === 0) {
      logger.info(`No more peers to check. Crawl for ${chainName} completed.`);
      break;
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

async function startCrawling(): Promise<Record<string, { newEndpoints: number, totalEndpoints: number, misplacedEndpoints: number }>> {
  const chainsData = loadChainsData();
  const totalChains = Object.keys(chainsData).length;
  logger.info(`Starting to crawl all chains. Total chains: ${totalChains}`);

  const results: Record<string, { newEndpoints: number, totalEndpoints: number, misplacedEndpoints: number }> = {};

  for (const [index, [chainName, chainData]] of Object.entries(chainsData).entries()) {
    logger.info(`Crawling chain ${index + 1}/${totalChains}: ${chainName}`);
    try {
      if (!chainData || !chainData['rpc-addresses'] || !Array.isArray(chainData['rpc-addresses'])) {
        logger.error(`Invalid chain data for ${chainName}`, { chainData });
        continue;
      }

      results[chainName] = await crawlNetwork(chainName, chainData['rpc-addresses']);
      
      // Save data after each chain is completed
      saveChainsData(chainsData);
      saveGoodIPs(goodIPs);
      saveRejectedIPs(rejectedIPs);

      logger.info(`Finished crawling chain ${index + 1}/${totalChains}: ${chainName}`);
    } catch (error) {
      logger.error(`Error crawling chain ${chainName}:`, error);
    }
  }

  logger.info('Finished crawling all chains');
  return results;
}

export { crawlNetwork, startCrawling };