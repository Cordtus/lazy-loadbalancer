const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const port = 3000;
const chainsFilePath = path.resolve(__dirname, 'chains.json');
const chainRegistryBaseUrl = 'https://raw.githubusercontent.com/cosmos/chain-registry/master/';

const getChainData = async (chainName) => {
  try {
    const response = await fetch(`${chainRegistryBaseUrl}${chainName}/chain.json`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Error fetching data for chain ${chainName}:`, error);
    return null;
  }
};

const updateChainData = async (chainName) => {
  const chainData = await getChainData(chainName);
  if (!chainData) return null;

  const newChainEntry = {
    "name": chainData.chain_name,
    "chain-id": chainData.chain_id,
    "account-prefix": chainData.bech32_prefix,
    "rpc-addresses": chainData.apis.rpc.map(api => api.address),
    "timeout": "30s",
    "last_updated": Date.now()
  };

  const chains = JSON.parse(fs.readFileSync(chainsFilePath, 'utf-8'));
  const existingChainIndex = chains.chains.findIndex(chain => chain['chain-id'] === newChainEntry['chain-id']);

  if (existingChainIndex > -1) {
    chains.chains[existingChainIndex] = newChainEntry;
  } else {
    chains.chains.push(newChainEntry);
  }

  fs.writeFileSync(chainsFilePath, JSON.stringify(chains, null, 2));
  return newChainEntry;
};

const getChainEntry = async (chainName) => {
  const chains = JSON.parse(fs.readFileSync(chainsFilePath, 'utf-8'));
  const chainEntry = chains.chains.find(chain => chain.name === chainName);

  if (!chainEntry || (Date.now() - chainEntry.last_updated > 12 * 60 * 60 * 1000)) {
    return await updateChainData(chainName);
  }
  return chainEntry;
};

app.get('/rpc-lb/:chainName', async (req, res) => {
  const chainName = req.params.chainName;
  const chainEntry = await getChainEntry(chainName);

  if (!chainEntry) {
    res.status(404).send('Chain not found');
    return;
  }

  res.json(chainEntry);
});

app.listen(port, () => {
  console.log(`Load balancer running at http://localhost:${port}`);
});
