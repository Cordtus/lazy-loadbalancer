import express, { Request, Response } from 'express';
import { crawlNetwork, startCrawling } from './crawler.js';
import { ChainEntry } from './types.js';
import { fetchChainData, checkAndUpdateChains, fetchChains } from './fetchChains.js';
import { ensureFilesExist, loadChainsData, saveChainsData } from './utils.js';
import fetch from 'node-fetch';
import logger from './logger.js';
import config from './config.js';

const app = express();
const PORT = config.port;

ensureFilesExist();

let chainsData: Record<string, ChainEntry> = loadChainsData();

async function updateChainData(chainName: string): Promise<void> {
  try {
    const chainData = await fetchChainData(chainName);
    if (chainData) {
      const currentChainsData = loadChainsData();
      currentChainsData[chainName] = {
        ...currentChainsData[chainName],
        ...chainData,
        'rpc-addresses': [...new Set([
          ...(currentChainsData[chainName]?.['rpc-addresses'] || []),
          ...chainData['rpc-addresses']
        ])],
        lastUpdated: new Date().toISOString()
      };
      saveChainsData(currentChainsData);

      await crawlNetwork(chainName, currentChainsData[chainName]['rpc-addresses']);
    }
  } catch (error) {
    logger.error('Error updating chain data:', error);
  }
}

async function updateEndpointData(chainName: string): Promise<void> {
  try {
    const chainEntry = chainsData[chainName];
    if (!chainEntry) {
      logger.error(`Chain ${chainName} does not exist.`);
      return;
    }

    await crawlNetwork(chainName, chainEntry['rpc-addresses']);
  } catch (error) {
    logger.error('Error updating endpoint data:', error);
  }
}

async function speedTest(chainName: string): Promise<void> {
  const chainEntry = chainsData[chainName];
  if (!chainEntry) {
    logger.error(`Chain ${chainName} does not exist.`);
    return;
  }

  const rpcAddresses = chainEntry['rpc-addresses'];
  const results: number[] = [];
  const exclusionList = new Set<string>();

  for (const rpcAddress of rpcAddresses) {
    if (exclusionList.has(rpcAddress)) {
      continue;
    }

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

  logger.info(`Total requests: ${totalRequests}`);
  logger.info(`Average time per request: ${avgTimePerRequest} ms`);
  logger.info(`Requests per second: ${1000 / avgTimePerRequest}`);
}

async function proxyRequest(chain: string, endpoint: string, res: Response): Promise<void> {
  const rpcAddresses = chainsData[chain]?.['rpc-addresses'];
  if (!rpcAddresses || rpcAddresses.length === 0) {
    res.status(500).send('No RPC addresses available for the specified chain.');
    return;
  }

  let successfulResponse = false;
  let currentIndex = 0;

  while (!successfulResponse && currentIndex < rpcAddresses.length) {
    const rpcAddress = rpcAddresses[currentIndex].replace(/\/$/, '');
    const url = `${rpcAddress}/${endpoint}`;
    logger.info(`Proxying request to: ${url}`);
    try {
      const response = await fetch(url);
      const data = await response.json();
      res.json(data);
      successfulResponse = true;
    } catch (error) {
      logger.error(`Error proxying request to ${url}:`, error);
      currentIndex++;
    }
  }

  if (!successfulResponse) {
    res.status(500).send('Error proxying request.');
  }
}

app.use(express.json());

app.post('/add-chain', async (req: Request, res: Response) => {
  const { chainName } = req.body;
  if (!chainName) {
    return res.status(400).send('Chain name is required.');
  }

  if (!chainsData[chainName]) {
    await updateChainData(chainName);
  }

  res.send('Chain added and data updated.');
});

app.post('/update-chain-data', async (req: Request, res: Response) => {
  const { chainName } = req.body;
  if (!chainName) {
    return res.status(400).send('Chain name is required.');
  }

  await updateChainData(chainName);
  res.send(`Chain data for ${chainName} updated.`);
});

app.post('/update-endpoint-data', async (req: Request, res: Response) => {
  const { chainName } = req.body;
  if (!chainName) {
    return res.status(400).send('Chain name is required.');
  }

  await updateEndpointData(chainName);
  if (chainsData[chainName]) {
    await crawlNetwork(chainName, chainsData[chainName]['rpc-addresses']);
  } else {
    logger.error(`Chain data for ${chainName} not found after updating endpoints.`);
  }
  res.send(`Endpoint data for ${chainName} updated and crawled.`);
});

app.get('/speed-test/:chainName', async (req: Request, res: Response) => {
  const { chainName } = req.params;
  await speedTest(chainName);
  res.send(`Speed test for ${chainName} completed. Check logs for details.`);
});

app.get('/rpc-lb/:chain/*', async (req: Request, res: Response) => {
  const { chain } = req.params;
  const endpoint = req.url.split(`${chain}/`)[1];

  if (!chainsData[chain]) {
    logger.info(`Chain data for ${chain} not found, updating...`);
    await updateChainData(chain);
  }

  await proxyRequest(chain, endpoint, res);
});

app.post('/update-all-chains', async (req: Request, res: Response) => {
  await fetchChains();
  res.send('All chains data updated.');
});

app.post('/:chain/update-chain', async (req: Request, res: Response) => {
  const { chain } = req.params;
  if (!chain) {
    return res.status(400).send('Chain name is required.');
  }

  await updateChainData(chain);
  res.send(`Chain data for ${chain} updated.`);
});

app.post('/crawl-all-chains', async (req: Request, res: Response) => {
  await startCrawling();
  res.send('Crawled all chains.');
});

app.post('/:chain/crawl-chain', async (req: Request, res: Response) => {
  const { chain } = req.params;
  const chainEntry = chainsData[chain];
  if (!chainEntry) {
    return res.status(400).send(`Chain ${chain} not found.`);
  }

  await crawlNetwork(chain, chainEntry['rpc-addresses']);
  res.send(`Crawled chain ${chain}.`);
});

app.get('/view-chains-data', (req, res) => {
  const chainsData = loadChainsData();
  res.json(chainsData);
});

app.listen(PORT, () => {
  logger.info(`Load balancer running at http://localhost:${PORT}`);
  setInterval(checkAndUpdateChains, config.chains.checkInterval);
});