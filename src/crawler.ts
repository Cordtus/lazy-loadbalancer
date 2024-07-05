import fetch, { RequestInit } from 'node-fetch';
import { Octokit } from "@octokit/core";
import dotenv from "dotenv";
import { ChainEntry, NetInfo, StatusInfo } from './types.js';
import { ensureFilesExist, loadChainsData, saveChainsData, loadRejectedIPs, saveRejectedIPs, logToFile, getDirName, loadGoodIPs, saveGoodIPs } from './utils.js';
import path from 'path';
import fs from 'fs';

dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_PAT,
});

ensureFilesExist();

const REPO_OWNER = "cosmos";
const REPO_NAME = "chain-registry";

const visitedNodes = new Set<string>();
const rejectedIPs = loadRejectedIPs();
const goodIPs = loadGoodIPs();
const timeout = 3000; // Timeout for requests in milliseconds
const logModuleName = 'crawler';

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result: T;
}

async function fetchNetInfo(url: string): Promise<NetInfo | null> {
  logToFile(logModuleName, `Fetching ${url}`);
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { signal: controller.signal } as RequestInit);
    clearTimeout(id);
    const data = (await response.json()) as JsonRpcResponse<NetInfo>;
    logToFile(logModuleName, `Fetched ${url} successfully`);
    return data.result;
  } catch (error) {
    const err = error as Error;
    console.error(`Error fetching ${url}:`, err.message);
    logToFile(logModuleName, `Error fetching ${url}: ${err.message}`);
    return null;
  }
}

async function fetchStatus(url: string): Promise<StatusInfo | null> {
  logToFile(logModuleName, `Fetching ${url}`);
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { signal: controller.signal } as RequestInit);
    clearTimeout(id);
    const data = (await response.json()) as JsonRpcResponse<StatusInfo>;
    logToFile(logModuleName, `Fetched ${url} successfully`);
    return data.result;
  } catch (error) {
    const err = error as Error;
    console.error(`Error fetching ${url}:`, err.message);
    logToFile(logModuleName, `Error fetching ${url}: ${err.message}`);
    return null;
  }
}

async function validateEndpoint(url: string): Promise<boolean> {
  logToFile(logModuleName, `Validating endpoint: ${url}`);
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { signal: controller.signal } as RequestInit);
    clearTimeout(id);
    logToFile(logModuleName, `Validation response from ${url}: ${response.status} ${response.statusText}`);
    const data = (await response.json()) as JsonRpcResponse<StatusInfo>;
    return response.ok && data.result.node_info.other.tx_index === 'on';
  } catch (error) {
    const err = error as Error;
    console.error(`Error validating endpoint ${url}:`, err.message);
    logToFile(logModuleName, `Error validating endpoint ${url}: ${err.message}`);
    return false;
  }
}

async function crawlNetwork(chainName: string, url: string, maxDepth: number, currentDepth = 0): Promise<void> {
  if (currentDepth > maxDepth) {
    logToFile(logModuleName, `Reached max depth: ${maxDepth} for ${url}`);
    return;
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (error) {
    const err = error as Error;
    console.error(`Invalid URL: ${url}`, err.message);
    logToFile(logModuleName, `Invalid URL: ${url} - ${err.message}`);
    return;
  }

  if (rejectedIPs.has(hostname)) {
    logToFile(logModuleName, `Skipping rejected IP: ${url}`);
    return;
  }

  if (goodIPs[hostname] && Date.now() - goodIPs[hostname] < 24 * 60 * 60 * 1000) {
    logToFile(logModuleName, `Skipping recently crawled good IP: ${url}`);
    return;
  }

  const netInfo = await fetchNetInfo(url);
  if (!netInfo) {
    logToFile(logModuleName, `No net info available for: ${url}`);
    return;
  }

  const statusUrl = url.replace('/net_info', '/status');
  const statusInfo = await fetchStatus(statusUrl);
  if (statusInfo) {
    const latestBlockHeight = statusInfo.sync_info.latest_block_height;
    const latestBlockTime = statusInfo.sync_info.latest_block_time;
    console.log(`Node: ${url}`);
    console.log(`Latest Block Height: ${latestBlockHeight}`);
    console.log(`Latest Block Time: ${latestBlockTime}`);
    logToFile(logModuleName, `Node: ${url}`);
    logToFile(logModuleName, `Latest Block Height: ${latestBlockHeight}`);
    logToFile(logModuleName, `Latest Block Time: ${latestBlockTime}`);
  }

  const peers = netInfo.peers;
  const chainsData = loadChainsData();
  const crawlPromises = peers.map(async (peer) => {
    const remoteIp = peer.remote_ip;
    let rpcAddress = peer.node_info.other.rpc_address
      .replace('tcp://', 'http://')
      .replace('0.0.0.0', remoteIp)
      .replace('127.0.0.1', remoteIp);

    // Ensure the URL is valid
    try {
      new URL(rpcAddress);
    } catch (error) {
      const err = error as Error;
      console.error(`Invalid RPC address: ${rpcAddress}`, err.message);
      logToFile(logModuleName, `Invalid RPC address: ${rpcAddress} - ${err.message}`);
      return;
    }

    if (rejectedIPs.has(new URL(rpcAddress).hostname) || visitedNodes.has(rpcAddress)) {
      logToFile(logModuleName, `Skipping already visited or rejected IP: ${rpcAddress}`);
      return;
    }

    visitedNodes.add(rpcAddress);
    console.log(`Crawling: ${rpcAddress}`);
    logToFile(logModuleName, `Crawling: ${rpcAddress}`);

    if (await validateEndpoint(`${rpcAddress}/status`)) {
      if (!chainsData[chainName]['rpc-addresses'].includes(rpcAddress)) {
        chainsData[chainName]['rpc-addresses'].push(rpcAddress);
        saveChainsData(chainsData);
        goodIPs[hostname] = Date.now();
        saveGoodIPs(goodIPs);
        console.log(`Added new RPC endpoint: ${rpcAddress}`);
        logToFile(logModuleName, `Added new RPC endpoint: ${rpcAddress}`);
      }
    } else {
      logToFile(logModuleName, `Rejected invalid RPC endpoint: ${rpcAddress}`);
      rejectedIPs.add(new URL(rpcAddress).hostname);
      saveRejectedIPs(rejectedIPs);
    }

    await crawlNetwork(chainName, `${rpcAddress}/net_info`, maxDepth, currentDepth + 1);
  });

  await Promise.all(crawlPromises);
}

async function fetchRPCAddresses(chainName: string): Promise<string[]> {
  try {
    console.log(`Fetching RPC addresses for: ${chainName}`);
    logToFile(logModuleName, `Fetching RPC addresses for: ${chainName}`);
    const response = await octokit.request(
      `GET /repos/{owner}/{repo}/contents/{path}`,
      {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: `${chainName}/chain.json`,
      }
    );
    console.log(`Response from GitHub for ${chainName}: ${response.status}`);
    logToFile(logModuleName, `Response from GitHub for ${chainName}: ${response.status}`);

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
    const err = error as Error;
    console.error(`Error fetching RPC addresses for ${chainName}:`, err.message);
    logToFile(logModuleName, `Error fetching RPC addresses for ${chainName}: ${err.message}`);
  }
  return [];
}

async function updateChains() {
  const chainsData: { [key: string]: ChainEntry } = loadChainsData();

  for (const chainName of Object.keys(chainsData)) {
    console.log(`Fetching RPC addresses for ${chainName}...`);
    logToFile(logModuleName, `Fetching RPC addresses for ${chainName}...`);
    const rpcAddresses = await fetchRPCAddresses(chainName);
    chainsData[chainName]['rpc-addresses'] = rpcAddresses;
    console.log(`${chainName}: ${rpcAddresses.length} RPC addresses found.`);
    logToFile(logModuleName, `${chainName}: ${rpcAddresses.length} RPC addresses found.`);
  }

  saveChainsData(chainsData);
  console.log("Chains data updated with RPC addresses.");
  logToFile(logModuleName, "Chains data updated with RPC addresses.");
}

// Entry point to start crawling
(async () => {
  await updateChains();

  const chainsData: { [key: string]: ChainEntry } = loadChainsData();
  const maxDepth = 3;

  for (const chainName of Object.keys(chainsData)) {
    const initialRPCs = chainsData[chainName]['rpc-addresses'];
    for (const rpc of initialRPCs) {
      await crawlNetwork(chainName, `${rpc}/net_info`, maxDepth);
    }
  }
})();

export { crawlNetwork, fetchNetInfo, updateChains };
