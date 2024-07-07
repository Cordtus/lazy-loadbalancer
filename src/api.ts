import express, { Request, Response } from 'express';
import { crawlNetwork, startCrawling } from './crawler.js';
import { fetchChainData, fetchChains } from './fetchChains.js';
import { loadChainsData, saveChainsData } from './utils.js';
import { balancerLogger as logger } from './logger.js';

const router = express.Router();

// Update a single chain's data from the registry
router.post('/update-chain/:chainName', async (req: Request, res: Response) => {
  const { chainName } = req.params;
  try {
    const chainData = await fetchChainData(chainName);
    if (chainData) {
      const chainsData = loadChainsData();
      chainsData[chainName] = chainData;
      saveChainsData(chainsData);
      res.send(`Chain data for ${chainName} updated from registry.`);
    } else {
      res.status(404).send(`Chain ${chainName} not found in registry.`);
    }
  } catch (error) {
    res.status(500).send(`Error updating chain data: ${(error as Error).message}`);
  }
});

// Update all chains from the registry
router.post('/update-all-chains', async (req: Request, res: Response) => {
  try {
    await fetchChains();
    res.send('All chains data updated from registry.');
  } catch (error) {
    res.status(500).send(`Error updating all chains: ${(error as Error).message}`);
  }
});

// Crawl a specific chain
router.post('/crawl-chain/:chainName', async (req: Request, res: Response) => {
  const { chainName } = req.params;
  try {
    const chainsData = loadChainsData();
    const chainEntry = chainsData[chainName];
    if (!chainEntry) {
      return res.status(404).send(`Chain ${chainName} not found.`);
    }
    const result = await crawlNetwork(chainName, chainEntry['rpc-addresses']);
    res.json({
      message: `Crawled chain ${chainName}.`,
      result
    });
  } catch (error) {
    res.status(500).send(`Error crawling chain: ${(error as Error).message}`);
  }
});

// Crawl all chains
router.post('/crawl-all-chains', async (req: Request, res: Response) => {
  try {
    const results = await startCrawling();
    res.json({
      message: 'Crawled all chains.',
      results
    });
  } catch (error) {
    res.status(500).send(`Error crawling all chains: ${(error as Error).message}`);
  }
});

// Get list of all chain names
router.get('/chain-list', (req: Request, res: Response) => {
  const chainsData = loadChainsData();
  res.json(Object.keys(chainsData));
});

// Get summary of all chains (name and number of endpoints)
router.get('/chains-summary', (req: Request, res: Response) => {
  const chainsData = loadChainsData();
  const summary = Object.entries(chainsData).map(([name, data]) => ({
    name,
    endpointCount: data['rpc-addresses'].length
  }));
  res.json(summary);
});

// In api.ts
router.get('/rpc-list/:chainName', (req: Request, res: Response) => {
  const { chainName } = req.params;
  const chainsData = loadChainsData();
  const chainData = chainsData[chainName];
  if (chainData) {
    res.json({
      chainName,
      rpcCount: chainData['rpc-addresses'].length,
      rpcList: chainData['rpc-addresses']
    });
  } else {
    res.status(404).send(`Chain ${chainName} not found.`);
  }
});

export default router;