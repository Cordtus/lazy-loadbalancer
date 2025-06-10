import express, { Request, Response } from 'express';
import { crawlNetwork, crawlAllChains } from './crawler.js';
import dataService from './dataService.js';
import { appLogger as logger } from './logger.js';
const router = express.Router();

// Get a list of all chains
router.get('/chain-list', async (req: Request, res: Response) => {
  const chainsData = await dataService.loadChainsData();
  const chainList = Object.keys(chainsData);
  res.json(chainList);
});

// Get a summary of all chains (name and number of endpoints)
router.get('/chains-summary', async (req: Request, res: Response) => {
  const chainsData = await dataService.loadChainsData();
  const summary = Object.entries(chainsData).map(([chainName, chainData]) => ({
    name: chainName,
    endpointCount: chainData['rpc-addresses'].length,
  }));
  res.json(summary);
});

// Get endpoints for a specific chain
router.get('/rpc-list/:chainName', async (req: Request, res: Response) => {
  const { chainName } = req.params;
  const chainData = await dataService.getChain(chainName);
  if (chainData) {
    res.json({
      chainName,
      rpcCount: chainData['rpc-addresses'].length,
      rpcList: chainData['rpc-addresses'],
    });
  } else {
    res.status(404).send(`Chain ${chainName} not found.`);
  }
});

// Update data for a specific chain
router.post('/update-chain/:chainName', async (req: Request, res: Response) => {
  const chainName = req.params.chainName;
  const chainData = await dataService.getChain(chainName);
  if (!chainData) {
    return res.status(404).json({ error: `Chain ${chainName} not found` });
  }

  try {
    logger.info(`Updating chain: ${chainName}`);
    const result = await crawlNetwork(chainName, chainData['rpc-addresses']);
    res.json(result);
  } catch (error) {
    logger.error(`Error updating chain ${chainName}:`, error);
    res.status(500).json({ error: `Failed to update chain ${chainName}` });
  }
});

// Update data for all chains
router.post('/update-all-chains', async (req: Request, res: Response) => {
  try {
    logger.info('Updating all chains');
    const results = await crawlAllChains();
    res.json(results);
  } catch (error) {
    logger.error('Error updating all chains:', error);
    res.status(500).json({ error: 'Failed to update all chains' });
  }
});

// Manually trigger blacklist cleanup
router.post('/cleanup-blacklist', async (req: Request, res: Response) => {
  try {
    logger.info('Performing blacklist cleanup');
    const result = await dataService.cleanupBlacklist();
    res.json({ message: 'Blacklist cleanup completed', result });
  } catch (error) {
    logger.error('Error during blacklist cleanup:', error);
    res.status(500).json({ error: 'Failed to cleanup blacklist' });
  }
});

// Add a new chain
router.post('/add-chain', async (req: Request, res: Response) => {
  const { chainName, chainId, rpcAddresses, bech32Prefix, accountPrefix } = req.body;
  if (
    !chainName ||
    !chainId ||
    !rpcAddresses ||
    !Array.isArray(rpcAddresses) ||
    !bech32Prefix ||
    !accountPrefix
  ) {
    return res.status(400).json({
      error:
        'Invalid chain data. Please provide chainName, chainId, rpcAddresses (array), bech32Prefix, and accountPrefix.',
    });
  }

  const existingChain = await dataService.getChain(chainName);
  if (existingChain) {
    return res.status(409).json({ error: `Chain ${chainName} already exists` });
  }

  const chainsData = await dataService.loadChainsData();
  chainsData[chainName] = {
    chain_name: chainName,
    'chain-id': chainId,
    'rpc-addresses': rpcAddresses,
    bech32_prefix: bech32Prefix,
    'account-prefix': accountPrefix,
    timeout: '30s', // Default timeout
  };

  await dataService.saveChainsData(chainsData);
  logger.info(`Added new chain: ${chainName}`);
  res.status(201).json({ message: `Chain ${chainName} added successfully` });
});

// Remove a chain
router.delete('/remove-chain/:chainName', async (req: Request, res: Response) => {
  const chainName = req.params.chainName;
  const chainsData = await dataService.loadChainsData();
  if (!chainsData[chainName]) {
    return res.status(404).json({ error: `Chain ${chainName} not found` });
  }

  delete chainsData[chainName];
  await dataService.saveChainsData(chainsData);
  logger.info(`Removed chain: ${chainName}`);
  res.json({ message: `Chain ${chainName} removed successfully` });
});

export default router;
