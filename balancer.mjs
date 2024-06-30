import express from 'express';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const app = express();
const port = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const chainsFilePath = path.resolve(__dirname, 'chains.json');
const chainRegistryBaseUrl = 'https://raw.githubusercontent.com/cosmos/chain-registry/master/';

const getChainData = async (chainName) => {
  try {
    const response = await fetch(`${chainRegistryBaseUrl}${chainName}/chain.json`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    console.log(`Fetched data for ${chainName}:`, data);
    return {
      name: data.chain_name,
      'chain-id': data.chain_id,
      'account-prefix': data.bech32_prefix,
      'rpc-addresses': data.apis.rpc.map(api => api.address),
      'timeout': '30s'
    };
  } catch (error) {
    console.error(`Error fetching data for chain ${chainName}:`, error);
    return null;
  }
};

const updateChainData = async (chainName) => {
  const chainData = await getChainData(chainName);
  if (!chainData) {
    console.error(`No chain data found for ${chainName}`);
    return null;
  }

  console.log(`New RPC addresses for ${chainName}:`, chainData['rpc-addresses']);
  let chains;
  try {
    chains = JSON.parse(fs.readFileSync(chainsFilePath, 'utf-8'));
  } catch (err) {
    console.error(`Error reading chains file:`, err);
    chains = { chains: [] };
  }

  const existingChainIndex = chains.chains.findIndex(chain => chain.name === chainName);

  if (existingChainIndex > -1) {
    const existingChain = chains.chains[existingChainIndex];
    console.log(`Existing chain found for ${chainName}:`, existingChain);

    // Update only if there are new addresses
    const updatedRpcAddresses = Array.from(new Set([...existingChain['rpc-addresses'], ...chainData['rpc-addresses']]));

    // Force update if there is no timestamp
    if (!existingChain['last_updated'] || existingChain['chain-id'] !== chainData['chain-id'] || !arraysEqual(existingChain['rpc-addresses'], updatedRpcAddresses)) {
      chains.chains[existingChainIndex] = {
        ...chainData,
        'rpc-addresses': updatedRpcAddresses,
        'last_updated': Date.now()
      };
      console.log(`Updated chain entry for ${chainName}:`, chains.chains[existingChainIndex]);
    } else {
      console.log(`No update needed for ${chainName}`);
    }
  } else {
    chains.chains.push({
      ...chainData,
      'last_updated': Date.now()
    });
    console.log(`Added new chain entry for ${chainName}:`, chainData);
  }

  fs.writeFileSync(chainsFilePath, JSON.stringify(chains, null, 2));
  console.log(`Chains file updated successfully`);
  return chains.chains[existingChainIndex] || chainData;
};

const arraysEqual = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const getChainEntry = async (chainName) => {
  let chains;
  try {
    chains = JSON.parse(fs.readFileSync(chainsFilePath, 'utf-8'));
  } catch (err) {
    console.error(`Error reading chains file:`, err);
    chains = { chains: [] };
  }

  const chainEntry = chains.chains.find(chain => chain.name === chainName);
  console.log(`Chain entry found for ${chainName}:`, chainEntry);

  // Force update if there is no timestamp
  if (!chainEntry || !chainEntry['last_updated'] || (Date.now() - chainEntry['last_updated'] > 12 * 60 * 60 * 1000)) {
    console.log(`Chain entry not found or outdated for ${chainName}, updating...`);
    return await updateChainData(chainName);
  }
  console.log(`Chain entry found for ${chainName}:`, chainEntry);
  return chainEntry;
};

const cycleRpcAddresses = (rpcAddresses) => {
  let index = 0;
  return () => {
    const rpcAddress = rpcAddresses[index];
    index = (index + 1) % rpcAddresses.length;
    return rpcAddress;
  };
};

const rpcCyclers = {};

app.get('/rpc-lb/:chainName', async (req, res) => {
  const chainName = req.params.chainName;
  const chainEntry = await getChainEntry(chainName);

  if (!chainEntry) {
    res.status(404).send('Chain not found');
    return;
  }

  if (!rpcCyclers[chainName]) {
    rpcCyclers[chainName] = cycleRpcAddresses(chainEntry['rpc-addresses']);
  }

  const rpcAddress = rpcCyclers[chainName]();
  res.json({ rpcAddress });
});

app.post('/api-query/:chainName', async (req, res) => {
  const chainName = req.params.chainName;
  const chainEntry = await getChainEntry(chainName);

  if (!chainEntry) {
    res.status(404).send('Chain not found');
    return;
  }

  if (!rpcCyclers[chainName]) {
    rpcCyclers[chainName] = cycleRpcAddresses(chainEntry['rpc-addresses']);
  }

  const rpcAddress = rpcCyclers[chainName]();
  const url = `${rpcAddress}${req.path}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error(`Error querying ${rpcAddress} for ${chainName}:`, error);
    res.status(500).send('Error querying RPC endpoint');
  }
});

app.listen(port, () => {
  console.log(`Load balancer running at http://localhost:${port}`);
});
