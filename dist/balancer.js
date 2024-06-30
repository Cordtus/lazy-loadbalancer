import express from 'express';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import https from 'https';
const app = express();
const port = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const chainsFilePath = path.resolve(__dirname, 'chains.json');
const chainRegistryBaseUrl = 'https://raw.githubusercontent.com/cosmos/chain-registry/master/';
const agent = new https.Agent({ rejectUnauthorized: false });
let chainCounters = {};
let failureCounts = {};
const failureThreshold = 3;
const getChainData = async (chainName) => {
    try {
        const response = await fetch(`${chainRegistryBaseUrl}${chainName}/chain.json`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json(); // Add type assertion
        console.log(`Fetched data for ${chainName}:`, data);
        return {
            name: data.chain_name,
            'chain-id': data.chain_id,
            'account-prefix': data.bech32_prefix,
            'rpc-addresses': data.apis.rpc.map((api) => api.address),
            'timeout': '30s'
        };
    }
    catch (error) {
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
    }
    catch (err) {
        console.error(`Error reading chains file:`, err);
        chains = { chains: [] };
    }
    const existingChainIndex = chains.chains.findIndex(chain => chain.name === chainName);
    if (existingChainIndex > -1) {
        const existingChain = chains.chains[existingChainIndex];
        console.log(`Existing chain found for ${chainName}:`, existingChain);
        const updatedRpcAddresses = Array.from(new Set([...existingChain['rpc-addresses'], ...chainData['rpc-addresses']]));
        if (!existingChain['last_updated'] || existingChain['chain-id'] !== chainData['chain-id'] || !arraysEqual(existingChain['rpc-addresses'], updatedRpcAddresses)) {
            chains.chains[existingChainIndex] = {
                ...chainData,
                'rpc-addresses': updatedRpcAddresses,
                'last_updated': Date.now()
            };
            console.log(`Updated chain entry for ${chainName}:`, chains.chains[existingChainIndex]);
        }
        else {
            console.log(`No update needed for ${chainName}`);
        }
    }
    else {
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
    if (a === b)
        return true;
    if (a == null || b == null)
        return false;
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; ++i) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
};
const getChainEntry = async (chainName) => {
    let chains;
    try {
        chains = JSON.parse(fs.readFileSync(chainsFilePath, 'utf-8'));
    }
    catch (err) {
        console.error(`Error reading chains file:`, err);
        chains = { chains: [] };
    }
    const chainEntry = chains.chains.find(chain => chain.name === chainName);
    console.log(`Chain entry found for ${chainName}:`, chainEntry);
    if (!chainEntry || !chainEntry['last_updated'] || (Date.now() - chainEntry['last_updated'] > 12 * 60 * 60 * 1000)) {
        console.log(`Chain entry not found or outdated for ${chainName}, updating...`);
        return await updateChainData(chainName);
    }
    console.log(`Chain entry found for ${chainName}:`, chainEntry);
    return chainEntry;
};
const getNextRpcAddress = (chainName, chainEntry) => {
    if (!chainCounters[chainName]) {
        chainCounters[chainName] = 0;
    }
    const rpcAddresses = chainEntry['rpc-addresses'];
    const validRpcAddresses = rpcAddresses.filter(addr => !(failureCounts[addr] && failureCounts[addr] >= failureThreshold));
    if (validRpcAddresses.length === 0) {
        console.error(`All RPC addresses for ${chainName} are blacklisted`);
        return null;
    }
    const nextIndex = chainCounters[chainName] % validRpcAddresses.length;
    chainCounters[chainName]++;
    return validRpcAddresses[nextIndex];
};
const handleRpcFailure = (rpcUrl) => {
    if (!failureCounts[rpcUrl]) {
        failureCounts[rpcUrl] = 0;
    }
    failureCounts[rpcUrl]++;
    console.log(`RPC address ${rpcUrl} has failed ${failureCounts[rpcUrl]} times`);
};
app.get('/rpc-lb/:chainName', async (req, res) => {
    const chainName = req.params.chainName;
    const chainEntry = await getChainEntry(chainName);
    if (!chainEntry) {
        res.status(404).send('Chain not found');
        return;
    }
    const rpcAddress = getNextRpcAddress(chainName, chainEntry);
    if (!rpcAddress) {
        res.status(503).send('All RPC addresses are blacklisted');
        return;
    }
    res.json({ rpcAddress });
});
app.all('/rpc-lb/:chainName/*', async (req, res) => {
    const chainName = req.params.chainName;
    const chainEntry = await getChainEntry(chainName);
    if (!chainEntry) {
        res.status(404).send('Chain not found');
        return;
    }
    const rpcUrl = getNextRpcAddress(chainName, chainEntry);
    if (!rpcUrl) {
        res.status(503).send('All RPC addresses are blacklisted');
        return;
    }
    const endpoint = req.params[0];
    try {
        const fetchOptions = {
            method: req.method,
            headers: { 'Content-Type': 'application/json' },
            body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
            agent,
        };
        const response = await fetch(`${rpcUrl}/${endpoint}`, fetchOptions);
        if (response.ok) {
            const data = await response.json();
            res.status(response.status).json(data);
        }
        else {
            handleRpcFailure(rpcUrl);
            res.status(response.status).json({ error: 'Failed to fetch from RPC endpoint' });
        }
    }
    catch (error) {
        handleRpcFailure(rpcUrl);
        res.status(500).json({ error: 'Internal server error' });
    }
});
app.listen(port, () => {
    console.log(`Load balancer running at http://localhost:${port}`);
});
