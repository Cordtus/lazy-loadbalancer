import { expect } from 'chai';
import { getChainData, updateChainData, getChainEntry } from '../balancer.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Mocking global variables for tests
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const chainsFilePath = path.resolve(__dirname, '../chains.json');

// Mock fetch
global.fetch = async (url) => {
  return {
    ok: true,
    json: async () => ({
      chain_name: 'akash',
      chain_id: 'akashnet-2',
      bech32_prefix: 'akash',
      apis: { rpc: [{ address: 'https://rpc.akash.forbole.com:443' }] }
    })
  };
};

describe('Load Balancer Tests', () => {
  it('fetches chain data', async () => {
    const data = await getChainData('akash');
    expect(data).to.have.property('chain_id');
    expect(data.chain_id).to.equal('akashnet-2');
  });

  it('updates chain data', async () => {
    const chainName = 'akash';
    const newChainEntry = await updateChainData(chainName);
    expect(newChainEntry).to.have.property('chain-id');
    expect(newChainEntry['chain-id']).to.equal('akashnet-2');

    const chains = JSON.parse(fs.readFileSync(chainsFilePath, 'utf-8'));
    const chainEntry = chains.chains.find(chain => chain.name === chainName);
    expect(chainEntry).to.exist;
  });

  it('gets chain entry', async () => {
    const chainName = 'akash';
    const chainEntry = await getChainEntry(chainName);
    expect(chainEntry).to.have.property('chain-id');
    expect(chainEntry['chain-id']).to.equal('akashnet-2');
  });
});
