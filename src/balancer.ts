import express from 'express';
import { crawlNetwork, updateChains } from './crawler.js';
import { ChainEntry } from './types.js';
import { fetchChainData, checkAndUpdateChains, fetchChains } from './fetchChains.js';
import { ensureFilesExist, loadChainsData, saveChainsData, logToFile } from './utils.js';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

ensureFilesExist();

const logModuleName = 'balancer';

let chainsData: Record<string, ChainEntry> = loadChainsData();

async function updateChainData(chainName: string) {
  try {
    const chainData = await fetchChainData(chainName);
    if (chainData) {
      chainsData[chainName] = chainData;
      saveChainsData(chainsData);

      const initialRpcUrl = chainsData[chainName]['rpc-addresses'][0] + '/net_info';
      console.log(`Starting network crawl from: ${initialRpcUrl}`);
      logToFile(logModuleName, `Starting network crawl from: ${initialRpcUrl}`);
      await crawlNetwork(chainName, initialRpcUrl, 3, 0);
    }
  } catch (error) {
    console.error('Error updating chain data:', error);
    logToFile(logModuleName, `Error updating chain data: ${error}`);
  }
}

async function updateEndpointData(chainName: string) {
  try {
    const chainEntry = chainsData[chainName];
    if (!chainEntry) {
      console.error(`Chain ${chainName} does not exist.`);
      logToFile(logModuleName, `Chain ${chainName} does not exist.`);
      return;
    }

    const initialRpcUrl = chainEntry['rpc-addresses'][0] + '/net_info';
    console.log(`Starting endpoint update from: ${initialRpcUrl}`);
    logToFile(logModuleName, `Starting endpoint update from: ${initialRpcUrl}`);
    await crawlNetwork(chainName, initialRpcUrl, 3, 0);
  } catch (error) {
    console.error('Error updating endpoint data:', error);
    logToFile(logModuleName, `Error updating endpoint data: ${error}`);
  }
}

async function speedTest(chainName: string) {
  const chainEntry = chainsData[chainName];
  if (!chainEntry) {
    console.error(`Chain ${chainName} does not exist.`);
    logToFile(logModuleName, `Chain ${chainName} does not exist.`);
    return;
  }

  const rpcAddresses = chainEntry['rpc-addresses'];
  const results = [];
  const exclusionList = new Set<string>();

  for (const rpcAddress of rpcAddresses) {
    if (exclusionList.has(rpcAddress)) {
      continue;
    }

    try {
      const startTime = Date.now();
      const response = await fetch(`${rpcAddress}/status`);
      const endTime = Date.now();
      if (response.status === 429) {
        exclusionList.add(rpcAddress);
      } else if (!response.ok) {
        exclusionList.add(rpcAddress);
      } else {
        results.push(endTime - startTime);
      }
    } catch (error) {
      console.error(`Error testing ${rpcAddress}:`, error);
      logToFile(logModuleName, `Error testing ${rpcAddress}: ${error}`);
      exclusionList.add(rpcAddress);
    }
  }

  const totalRequests = results.length;
  const totalTime = results.reduce((acc, curr) => acc + curr, 0);
  const avgTimePerRequest = totalTime / totalRequests;

  console.log(`Total requests: ${totalRequests}`);
  console.log(`Average time per request: ${avgTimePerRequest} ms`);
  console.log(`Requests per second: ${1000 / avgTimePerRequest}`);
  logToFile(logModuleName, `Total requests: ${totalRequests}`);
  logToFile(logModuleName, `Average time per request: ${avgTimePerRequest} ms`);
  logToFile(logModuleName, `Requests per second: ${1000 / avgTimePerRequest}`);
}

async function proxyRequest(chain: string, endpoint: string, res: express.Response) {
  const rpcAddresses = chainsData[chain]?.['rpc-addresses'];
  if (!rpcAddresses || rpcAddresses.length === 0) {
    return res.status(500).send('No RPC addresses available for the specified chain.');
  }

  let successfulResponse = false;
  let currentIndex = 0;

  while (!successfulResponse && currentIndex < rpcAddresses.length) {
    const rpcAddress = rpcAddresses[currentIndex];
    console.log(`Proxying request to: ${rpcAddress}/${endpoint}`);
    logToFile(logModuleName, `Proxying request to: ${rpcAddress}/${endpoint}`);
    try {
      const response = await fetch(`${rpcAddress}/${endpoint}`);
      const data = await response.json();
      res.json(data);
      successfulResponse = true;
    } catch (error) {
      console.error(`Error proxying request to ${rpcAddress}/${endpoint}:`, error);
      logToFile(logModuleName, `Error proxying request to ${rpcAddress}/${endpoint}: ${error}`);
      currentIndex++;
    }
  }

  if (!successfulResponse) {
    res.status(500).send('Error proxying request.');
    logToFile(logModuleName, 'Error proxying request.');
  }
}

app.use(express.json());

app.post('/add-chain', async (req, res) => {
  const { chainName } = req.body;
  if (!chainName) {
    return res.status(400).send('Chain name is required.');
  }

  if (!chainsData[chainName]) {
    await updateChainData(chainName);
  }

  res.send('Chain added and data updated.');
});

app.post('/update-chain-data', async (req, res) => {
  const { chainName } = req.body;
  if (!chainName) {
    return res.status(400).send('Chain name is required.');
  }

  await updateChainData(chainName);
  res.send(`Chain data for ${chainName} updated.`);
});

app.post('/update-endpoint-data', async (req, res) => {
  const { chainName } = req.body;
  if (!chainName) {
    return res.status(400).send('Chain name is required.');
  }

  await updateEndpointData(chainName);
  res.send(`Endpoint data for ${chainName} updated.`);
});

app.get('/speed-test/:chainName', async (req, res) => {
  const { chainName } = req.params;
  await speedTest(chainName);
  res.send(`Speed test for ${chainName} completed. Check logs for details.`);
});

app.get('/rpc-lb/:chain/:endpoint', async (req, res) => {
  const { chain, endpoint } = req.params;

  if (!chainsData[chain]) {
    console.log(`Chain data for ${chain} not found, updating...`);
    logToFile(logModuleName, `Chain data for ${chain} not found, updating...`);
    await updateChainData(chain);
  }

  await proxyRequest(chain, endpoint, res);
});

app.post('/update-all-chains', async (req, res) => {
  await fetchChains();
  res.send('All chains data updated.');
});

app.post('/:chain/update-chain', async (req, res) => {
  const { chain } = req.params;
  if (!chain) {
    return res.status(400).send('Chain name is required.');
  }

  await updateChainData(chain);
  res.send(`Chain data for ${chain} updated.`);
});

app.post('/crawl-all-chains', async (req, res) => {
  const chainsData: { [key: string]: ChainEntry } = loadChainsData();
  const maxDepth = 3;

  for (const chainName of Object.keys(chainsData)) {
    const initialRPCs = chainsData[chainName]['rpc-addresses'];
    for (const rpc of initialRPCs) {
      await crawlNetwork(chainName, `${rpc}/net_info`, maxDepth);
    }
  }

  res.send('Crawled all chains.');
});

app.post('/:chain/crawl-chain', async (req, res) => {
  const { chain } = req.params;
  const chainEntry = chainsData[chain];
  if (!chainEntry) {
    return res.status(400).send(`Chain ${chain} not found.`);
  }

  const initialRpcUrl = chainEntry['rpc-addresses'][0] + '/net_info';
  await crawlNetwork(chain, initialRpcUrl, 3, 0);
  res.send(`Crawled chain ${chain}.`);
});

app.listen(PORT, () => {
  console.log(`Load balancer running at http://localhost:${PORT}`);
  logToFile(logModuleName, `Load balancer running at http://localhost:${PORT}`);
  setInterval(checkAndUpdateChains, 24 * 60 * 60 * 1000); // Periodic update every 24 hours
});
