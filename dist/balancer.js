import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { crawlNetwork } from './crawler.js';
const app = express();
const PORT = process.env.PORT || 3000;
// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHAINS_FILE_PATH = path.resolve(__dirname, '../data/chains.json');
let chainsData;
function loadChainsData() {
    try {
        const data = fs.readFileSync(CHAINS_FILE_PATH, 'utf-8');
        chainsData = JSON.parse(data);
        console.log('Chains data loaded.');
    }
    catch (error) {
        console.error('Error reading chains file:', error);
        chainsData = {};
    }
}
function saveChainsData() {
    try {
        fs.writeFileSync(CHAINS_FILE_PATH, JSON.stringify(chainsData, null, 2));
        console.log('Chains data saved.');
    }
    catch (error) {
        console.error('Error writing chains file:', error);
    }
}
async function updateChainData(chainName) {
    const chainInfoUrl = `https://raw.githubusercontent.com/cosmos/chain-registry/master/${chainName}/chain.json`;
    try {
        const response = await fetch(chainInfoUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch chain data for ${chainName}`);
        }
        const data = (await response.json());
        chainsData[chainName] = {
            chain_name: data.chain_name,
            'chain-id': data['chain-id'],
            bech32_prefix: data.bech32_prefix,
            'account-prefix': data['account-prefix'],
            'rpc-addresses': data.apis?.rpc.map(api => api.address) || [],
            timeout: '30s',
            apis: data.apis // ensure we store the whole apis object
        };
        saveChainsData();
        const initialRpcUrl = chainsData[chainName]['rpc-addresses'][0] + '/net_info';
        console.log(`Starting network crawl from: ${initialRpcUrl}`);
        await crawlNetwork(initialRpcUrl, 3);
    }
    catch (error) {
        console.error('Error updating chain data:', error);
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
app.get('/rpc-lb/:chain/:endpoint', async (req, res) => {
    const { chain, endpoint } = req.params;
    if (!chainsData[chain]) {
        console.log(`Chain data for ${chain} not found, updating...`);
        await updateChainData(chain);
    }
    const rpcAddresses = chainsData[chain]?.['rpc-addresses'];
    if (!rpcAddresses || rpcAddresses.length === 0) {
        return res.status(500).send('No RPC addresses available for the specified chain.');
    }
    const rpcAddress = rpcAddresses[Math.floor(Math.random() * rpcAddresses.length)];
    console.log(`Proxying request to: ${rpcAddress}/${endpoint}`);
    try {
        const response = await fetch(`${rpcAddress}/${endpoint}`);
        const data = await response.json();
        res.json(data);
    }
    catch (error) {
        console.error(`Error proxying request to ${rpcAddress}/${endpoint}:`, error);
        res.status(500).send('Error proxying request.');
    }
});
loadChainsData();
app.listen(PORT, () => {
    console.log(`Load balancer running at http://localhost:${PORT}`);
});
