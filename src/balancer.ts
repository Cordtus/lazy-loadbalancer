import express, { Request, Response } from 'express';
import { crawlNetwork, startCrawling } from './crawler.js';
import { fetchChainData, fetchChains, checkAndUpdateChains } from './fetchChains.js';
import { loadChainsData, saveChainsData, ensureFilesExist, loadBlacklistedIPs, saveBlacklistedIPs } from './utils.js';
import { balancerLogger as logger } from './logger.js';
import config from './config.js';
import { ChainEntry } from './types.js';
import https from 'https';
import fetch, { RequestInit } from 'node-fetch';

const app = express();
const PORT = config.port;

ensureFilesExist();

let chainsData: Record<string, ChainEntry> = loadChainsData();
const rpcIndexMap: Record<string, number> = {};

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

async function updateChainData(chainName: string): Promise<void> {
  try {
    const chainData = await fetchChainData(chainName);
    if (chainData) {
      const blacklistedIPs = new Set(loadBlacklistedIPs());
      chainData['rpc-addresses'] = chainData['rpc-addresses'].filter(addr => !blacklistedIPs.has(new URL(addr).hostname));
      chainsData[chainName] = { ...chainsData[chainName], ...chainData };
      saveChainsData(chainsData);
      await crawlNetwork(chainName, chainsData[chainName]['rpc-addresses']);
    }
  } catch (error) {
    logger.error('Error updating chain data:', error);
    throw new Error(`Failed to update chain data: ${(error as Error).message}`);
  }
}

async function updateRPCList(chain: string, failedAddresses: string[]): Promise<void> {
  const chainData = chainsData[chain];
  if (!chainData) return;

  chainData['rpc-addresses'] = chainData['rpc-addresses'].filter(addr => !failedAddresses.includes(addr));
  
  // Add failed addresses to blacklist
  const blacklist = new Set(loadBlacklistedIPs());
  failedAddresses.forEach(addr => blacklist.add(new URL(addr).hostname));
  saveBlacklistedIPs(Array.from(blacklist));

  // Update chain data
  saveChainsData(chainsData);

  // If RPC list is getting low, trigger a crawl
  if (chainData['rpc-addresses'].length < 3) {
    logger.warn(`Low RPC count for ${chain}, triggering crawl`);
    crawlNetwork(chain, chainData['rpc-addresses']).catch(err => 
      logger.error(`Error crawling network for ${chain}:`, err)
    );
  }
}

async function proxyRequest(chain: string, endpoint: string, req: Request, res: Response): Promise<void> {
  const rpcAddresses = chainsData[chain]?.['rpc-addresses'];
  if (!rpcAddresses || rpcAddresses.length === 0) {
    res.status(500).send('No RPC addresses available for the specified chain.');
    return;
  }

  if (!(chain in rpcIndexMap)) {
    rpcIndexMap[chain] = 0;
  }

  let attempts = 0;
  const maxAttempts = rpcAddresses.length;
  const failedAttempts: string[] = [];

  while (attempts < maxAttempts) {
    const rpcAddress = rpcAddresses[rpcIndexMap[chain]];
    const url = new URL(`${rpcAddress.replace(/\/$/, '')}/${endpoint}`);
    logger.info(`Proxying ${req.method} request to: ${url.href}`);
    logger.debug(`Request headers: ${JSON.stringify(req.headers)}`);
    logger.debug(`Request body: ${JSON.stringify(req.body)}`);

    try {
      const fetchOptions: RequestInit = {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Host': url.hostname,
          ...Object.fromEntries(
            Object.entries(req.headers)
              .filter(([key]) => !['host', 'content-length'].includes(key.toLowerCase()))
          ),
        },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(config.requestTimeout),
        agent: httpsAgent,
      };

      const response = await fetch(url.href, fetchOptions);
      const responseText = await response.text();

      logger.debug(`Response status: ${response.status}`);
      logger.debug(`Response headers: ${JSON.stringify(Object.fromEntries(response.headers))}`);
      logger.debug(`Response body: ${responseText}`);

      if (response.ok) {
        // Set safe headers
        for (const [key, value] of response.headers.entries()) {
          if (!['content-encoding', 'content-length'].includes(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        }
        
        // Try to parse as JSON, if it fails, send as text
        try {
          const jsonData = JSON.parse(responseText);
          res.status(response.status).json(jsonData);
        } catch {
          res.status(response.status).send(responseText);
        }
        return;
      } else {
        logger.error(`Non-OK response from ${url.href}: ${response.status}`);
        failedAttempts.push(rpcAddress);
      }
    } catch (error: any) {
      logger.error(`Error proxying request to ${url.href}:`, error);
      failedAttempts.push(rpcAddress);
    }

    rpcIndexMap[chain] = (rpcIndexMap[chain] + 1) % rpcAddresses.length;
    attempts++;
  }

  // Update the RPC list and blacklist failed addresses
  if (failedAttempts.length > 0) {
    await updateRPCList(chain, failedAttempts);
  }

  res.status(502).send('Unable to process request after multiple attempts');
}

app.use(express.json());

app.all('/lb/:chain/*', async (req: Request, res: Response) => {
  const { chain } = req.params;
  const endpoint = req.params[0];

  logger.debug(`Received ${req.method} request for chain: ${chain}, endpoint: ${endpoint}`);
  logger.debug(`Request headers: ${JSON.stringify(req.headers)}`);
  logger.debug(`Request body: ${JSON.stringify(req.body)}`);

  try {
    if (!chainsData[chain]) {
      logger.info(`Chain data for ${chain} not found, updating...`);
      await updateChainData(chain);
    }

    await proxyRequest(chain, endpoint, req, res);
  } catch (error) {
    logger.error(`Error proxying request for ${chain}/${endpoint}:`, error);
    res.status(500).send(`Error proxying request: ${(error as Error).message}`);
  }
});

app.post('/add-chain', async (req: Request, res: Response) => {
  const { chainName } = req.body;
  if (!chainName) {
    return res.status(400).send('Chain name is required.');
  }

  try {
    await updateChainData(chainName);
    res.send('Chain added and data updated.');
  } catch (error) {
    res.status(500).send(`Error adding chain: ${(error as Error).message}`);
  }
});

app.post('/update-chain-data', async (req: Request, res: Response) => {
  const { chainName } = req.body;
  if (!chainName) {
    return res.status(400).send('Chain name is required.');
  }

  try {
    await updateChainData(chainName);
    res.send(`Chain data for ${chainName} updated.`);
  } catch (error) {
    res.status(500).send(`Error updating chain data: ${(error as Error).message}`);
  }
});

app.post('/update-endpoint-data', async (req: Request, res: Response) => {
  const { chainName } = req.body;
  if (!chainName) {
    return res.status(400).send('Chain name is required.');
  }

  try {
    await updateChainData(chainName);
    res.send(`Endpoint data for ${chainName} updated and crawled.`);
  } catch (error) {
    res.status(500).send(`Error updating endpoint data: ${(error as Error).message}`);
  }
});

app.all('/lb/:chain/*', async (req: Request, res: Response) => {
  const { chain } = req.params;
  const endpoint = req.params[0];

  logger.debug(`Received ${req.method} request for chain: ${chain}, endpoint: ${endpoint}`);
  logger.debug(`Request headers: ${JSON.stringify(req.headers)}`);
  logger.debug(`Request body: ${JSON.stringify(req.body)}`);

  try {
    if (!chainsData[chain]) {
      logger.info(`Chain data for ${chain} not found, updating...`);
      await updateChainData(chain);
    }

    await proxyRequest(chain, endpoint, req, res);
  } catch (error) {
    logger.error(`Error proxying request for ${chain}/${endpoint}:`, error);
    res.status(500).send(`Error proxying request: ${(error as Error).message}`);
  }
});

app.post('/update-all-chains', async (req: Request, res: Response) => {
  try {
    await fetchChains();
    res.send('All chains data updated.');
  } catch (error) {
    res.status(500).send(`Error updating all chains: ${(error as Error).message}`);
  }
});

app.post('/:chain/update-chain', async (req: Request, res: Response) => {
  const { chain } = req.params;
  if (!chain) {
    return res.status(400).send('Chain name is required.');
  }

  try {
    await updateChainData(chain);
    res.send(`Chain data for ${chain} updated.`);
  } catch (error) {
    res.status(500).send(`Error updating chain data: ${(error as Error).message}`);
  }
});

app.post('/crawl-all-chains', async (req: Request, res: Response) => {
  try {
    await startCrawling();
    res.send('Crawled all chains.');
  } catch (error) {
    res.status(500).send(`Error crawling all chains: ${(error as Error).message}`);
  }
});

app.post('/:chain/crawl-chain', async (req: Request, res: Response) => {
  const { chain } = req.params;
  try {
    const chainEntry = chainsData[chain];
    if (!chainEntry) {
      return res.status(404).send(`Chain ${chain} not found.`);
    }
    await crawlNetwork(chain, chainEntry['rpc-addresses']);
    res.send(`Crawled chain ${chain}.`);
  } catch (error) {
    res.status(500).send(`Error crawling chain: ${(error as Error).message}`);
  }
});

app.listen(PORT, () => {
  logger.info(`Load balancer running at http://localhost:${PORT}`);
  setInterval(checkAndUpdateChains, config.chains.checkInterval);
});