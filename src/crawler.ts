import fetch, { RequestInit } from 'node-fetch';
import { Octokit } from "@octokit/core";
import dotenv from "dotenv";
import { ChainEntry } from './types.js';
import { ensureChainsFileExists, loadChainsData, saveChainsData } from './utils.js';

dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_PAT,
});

// Ensure chains.json file exists
ensureChainsFileExists();

const REPO_OWNER = "cosmos";
const REPO_NAME = "chain-registry";

interface NetInfo {
  peers: Array<{
    remote_ip: string;
    node_info: {
      other: {
        rpc_address: string;
      };
    };
  }>;
}

interface StatusInfo {
  sync_info: {
    earliest_block_height: string;
    earliest_block_time: string;
  };
}

const visitedNodes = new Set<string>();
const timeout = 3000; // Timeout for requests in milliseconds

async function fetchNetInfo(url: string): Promise<NetInfo | null> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { signal: controller.signal } as RequestInit);
    clearTimeout(id);
    const data = (await response.json()) as { result: NetInfo };
    return data.result;
  } catch (error) {
    console.error(`Error fetching ${url}:`, (error as Error).message);
    return null;
  }
}

async function fetchStatus(url: string): Promise<StatusInfo | null> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { signal: controller.signal } as RequestInit);
    clearTimeout(id);
    const data = (await response.json()) as { result: StatusInfo };
    return data.result;
  } catch (error) {
    console.error(`Error fetching ${url}:`, (error as Error).message);
    return null;
  }
}

async function fetchRPCAddresses(chainName: string): Promise<string[]> {
  try {
    const response = await octokit.request(
      `GET /repos/{owner}/{repo}/contents/{path}`,
      {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: `${chainName}/chain.json`,
      }
    );

    if (Array.isArray(response.data)) {
      return [];
    }

    const fileData = response.data as { content?: string };
    if (fileData.content) {
      const content = Buffer.from(fileData.content, "base64").toString();
      const chainData = JSON.parse(content);
      return chainData.apis?.rpc?.map((rpc: { address: string }) => rpc.address) || [];
    }
  } catch (error) {
    console.error(`Error fetching RPC addresses for ${chainName}:`, error);
  }
  return [];
}

async function crawlNetwork(url: string, maxDepth: number, currentDepth = 0): Promise<void> {
  if (currentDepth > maxDepth) {
    return;
  }

  const netInfo = await fetchNetInfo(url);
  if (!netInfo) {
    return;
  }

  const statusUrl = url.replace('/net_info', '/status');
  const statusInfo = await fetchStatus(statusUrl);
  if (statusInfo) {
    const earliestBlockHeight = statusInfo.sync_info.earliest_block_height;
    const earliestBlockTime = statusInfo.sync_info.earliest_block_time;
    console.log(`Node: ${url}`);
    console.log(`Earliest Block Height: ${earliestBlockHeight}`);
    console.log(`Earliest Block Time: ${earliestBlockTime}`);
  }

  const peers = netInfo.peers;
  const crawlPromises = peers.map(async (peer) => {
    const remoteIp = peer.remote_ip;
    let rpcAddress = peer.node_info.other.rpc_address.replace('tcp://', 'http://').replace('0.0.0.0', remoteIp);

    // Ensure the URL is valid
    if (!rpcAddress || rpcAddress === 'http://') {
      return;
    }

    if (!visitedNodes.has(rpcAddress)) {
      visitedNodes.add(rpcAddress);
      console.log(`Crawling: ${rpcAddress}`);
      await crawlNetwork(`${rpcAddress}/net_info`, maxDepth, currentDepth + 1);
    }
  });

  await Promise.all(crawlPromises);
}

async function updateChains() {
  const chainsData: { [key: string]: ChainEntry } = loadChainsData();

  for (const chainName of Object.keys(chainsData)) {
    console.log(`Fetching RPC addresses for ${chainName}...`);
    const rpcAddresses = await fetchRPCAddresses(chainName);
    chainsData[chainName]['rpc-addresses'] = rpcAddresses;
    console.log(`${chainName}: ${rpcAddresses.length} RPC addresses found.`);
  }

  saveChainsData(chainsData);
  console.log("Chains data updated with RPC addresses.");
}

// Entry point to start crawling
(async () => {
  await updateChains();

  // Load chainsData again to ensure updated data is used
  const chainsData: { [key: string]: ChainEntry } = loadChainsData();

  // Assuming we start crawling from some initial known RPC URL for each chain
  const initialRPCs = Object.values(chainsData).flatMap(chain => chain['rpc-addresses']);
  const maxDepth = 3; // Define your desired crawling depth

  for (const rpc of initialRPCs) {
    await crawlNetwork(`${rpc}/net_info`, maxDepth);
  }
})();

export { crawlNetwork, fetchNetInfo };
