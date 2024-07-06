import express, { Request, Response } from 'express';
import { crawlNetwork, startCrawling } from './crawler.js';
import { fetchChainData, fetchChains, checkAndUpdateChains } from './fetchChains.js';
import { loadChainsData, saveChainsData, ensureFilesExist } from './utils.js';
import { balancerLogger as logger } from './logger.js';
import config from './config.js';
import { ChainEntry } from './types.js';
import fetch, { RequestInit } from 'node-fetch';

const app = express();
const PORT = config.port;

ensureFilesExist();

let chainsData: Record<string, ChainEntry> = loadChainsData();
const rpcIndexMap: Record<string, number> = {};

async function updateChainData(chainName: string): Promise<void> {
  try {
    const chainData = await fetchChainData(chainName);
    if (chainData) {
      chainsData[chainName] = { ...chainsData[chainName], ...chainData };
      saveChainsData(chainsData);
      await crawlNetwork(chainName, chainsData[chainName]['rpc-addresses']);
    }
  } catch (error) {
    logger.error('Error updating chain data:', error);
    throw new Error(`Failed to update chain data: ${(error as Error).message}`);
  }
}

async function updateEndpointData(chainName: string): Promise<void> {
  try {
    const chainEntry = chainsData[chainName];
    if (!chainEntry) {
      throw new Error(`Chain ${chainName} does not exist.`);
    }
    await crawlNetwork(chainName, chainEntry['rpc-addresses']);
  } catch (error) {
    logger.error('Error updating endpoint data:', error);
    throw new Error(`Failed to update endpoint data: ${(error as Error).message}`);
  }
}

async function speedTest(chainName: string): Promise<{
  totalRequests: number;
  avgTimePerRequest: number;
  requestsPerSecond: number;
}> {
  const chainEntry = chainsData[chainName];
  if (!chainEntry) {
    throw new Error(`Chain ${chainName} does not exist.`);
  }

  const rpcAddresses = chainEntry['rpc-addresses'];
  const results: number[] = [];
  const exclusionList = new Set<string>();

  for (const rpcAddress of rpcAddresses) {
    if (exclusionList.has(rpcAddress)) continue;

    try {
      const startTime = Date.now();
      const response = await fetch(`${rpcAddress}/status`);
      const endTime = Date.now();
      if (response.status === 429 || !response.ok) {
        exclusionList.add(rpcAddress);
      } else {
        results.push(endTime - startTime);
      }
    } catch (error) {
      logger.error(`Error testing ${rpcAddress}:`, error);
      exclusionList.add(rpcAddress);
    }
  }

  const totalRequests = results.length;
  const totalTime = results.reduce((acc, curr) => acc + curr, 0);
  const avgTimePerRequest = totalTime / totalRequests;
  const requestsPerSecond = 1000 / avgTimePerRequest;

  logger.info(`Total requests: ${totalRequests}`);
  logger.info(`Average time per request: ${avgTimePerRequest} ms`);
  logger.info(`Requests per second: ${requestsPerSecond}`);

  return { totalRequests, avgTimePerRequest, requestsPerSecond };
}

async function proxyRequest(chain: string, endpoint: string, res: Response): Promise<void> {
  const rpcAddresses = chainsData[chain]?.['rpc-addresses'];
  if (!rpcAddresses || rpcAddresses.length === 0) {
    res.status(500).send('No RPC addresses available for the specified chain.');
    return;
  }

  if (!(chain in rpcIndexMap)) {
    rpcIndexMap[chain] = 0;
  }

  let attempts = 0;
  const maxAttempts = Math.min(3, rpcAddresses.length);

  while (attempts < maxAttempts) {
    const rpcAddress = rpcAddresses[rpcIndexMap[chain]];
    const url = `${rpcAddress.replace(/\/$/, '')}/${endpoint}`;
    logger.info(`Proxying request to: ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await fetch(url, { signal: controller.signal } as RequestInit);
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        res.json(data);
        rpcIndexMap[chain] = (rpcIndexMap[chain] + 1) % rpcAddresses.length;
        return;
      } else {
        logger.error(`Non-OK response from ${url}: ${response.status}`);
        const errorText = await response.text();
        logger.error(`Response body: ${errorText}`);
        if (response.status === 404) {
          res.status(404).send('Endpoint not found.');
          return;
        }
      }
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        res.status(504).send('Request timed out.');
        return;
      } else {
        logger.error(`Error proxying request to ${url}:`, error);
      }
    }

    rpcIndexMap[chain] = (rpcIndexMap[chain] + 1) % rpcAddresses.length;
    attempts++;
  }

  res.status(500).send('Error proxying request to all available RPC addresses.');
}

app.use(express.json());

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
    await updateEndpointData(chainName);
    res.send(`Endpoint data for ${chainName} updated and crawled.`);
  } catch (error) {
    res.status(500).send(`Error updating endpoint data: ${(error as Error).message}`);
  }
});

app.get('/speed-test/:chainName', async (req: Request, res: Response) => {
  const { chainName } = req.params;
  try {
    const result = await speedTest(chainName);
    res.json(result);
  } catch (error) {
    res.status(500).send(`Error during speed test: ${(error as Error).message}`);
  }
});

app.get('/rpc-lb/:chain/*', async (req: Request, res: Response) => {
  const { chain } = req.params;
  const endpoint = req.params[0];

  try {
    if (!chainsData[chain]) {
      logger.info(`Chain data for ${chain} not found, updating...`);
      await updateChainData(chain);
    }
    await proxyRequest(chain, endpoint, res);
  } catch (error) {
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
    res.status (500).send(`Error crawling all chains: ${(error as Error).message}`);
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

