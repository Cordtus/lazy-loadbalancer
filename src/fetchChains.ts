import { Octokit } from "@octokit/core";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { ChainEntry, ChainData } from "./types";
import { ensureFilesExist, loadChainsData, logToFile, saveChainsData } from './utils.js';
import { appLogger as logger } from './logger.js';
import config from './config.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_PAT,
});

const REPO_OWNER = "cosmos";
const REPO_NAME = "chain-registry";
const UPDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

const logModuleName = 'fetchChains';

async function fetchChainData(chain: string): Promise<ChainEntry | null> {
  const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/${chain}/chain.json`;
  logToFile(logModuleName, `Fetching chain data from URL: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch data for chain: ${chain}`);
      logToFile(logModuleName, `Failed to fetch data for chain: ${chain}`);
      return null;
    }

    const data = await response.json() as ChainData;

    return {
      chain_name: data.chain_name,
      'chain-id': data.chain_id,
      bech32_prefix: data.bech32_prefix,
      'account-prefix': data.bech32_prefix, // Assuming 'account-prefix' is same as 'bech32_prefix'
      'rpc-addresses': data.apis.rpc.map((rpc) => rpc.address),
      timeout: "30s", // Assuming default timeout is 30s
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error(`Error fetching data for chain ${chain}:`, error);
    logToFile(logModuleName, `Error fetching data for chain ${chain}: ${error}`);
    return null;
  }
}

async function fetchChains() {
  ensureFilesExist();

  try {
    logger.info(`Fetching chains...`);
    const response = await octokit.request(`GET /repos/{owner}/{repo}/contents`, {
      owner: config.github.owner,
      repo: config.github.repo,
    });

    const chainsData: { [key: string]: ChainEntry } = {};
    const now = Date.now();

    if (Array.isArray(response.data)) {
      for (const item of response.data) {
        if (
          item.type === "dir" &&
          !item.name.startsWith(".") &&
          !item.name.startsWith("_") &&
          item.name !== "testnets"
        ) {
          const chainData = await fetchChainData(item.name);
          if (chainData) {
            chainsData[item.name] = chainData;
            // Save individual chain file
            const chainFilePath = path.join(process.cwd(), 'data', `${item.name}.json`);
            fs.writeFileSync(chainFilePath, JSON.stringify(chainData, null, 2));
            logger.info(`Fetched and saved data for chain: ${item.name}`);
          }
        }
      }
    }

    // Save the list of all chains
    const chainListPath = path.join(process.cwd(), 'data', 'chain_list.json');
    fs.writeFileSync(chainListPath, JSON.stringify(Object.keys(chainsData), null, 2));
    logger.info(`Chain list saved: ${Object.keys(chainsData).length} chains`);

    // We don't need to save all chains in a single file anymore
    // saveChainsData(chainsData);
  } catch (error) {
    logger.error("Error fetching chains data:", error);
  }
}

function checkAndUpdateChains() {
  const chainsData: { [key: string]: ChainEntry } = loadChainsData();

  const now = Date.now();
  const promises = Object.keys(chainsData).map(async (chain) => {
    const chainEntry = chainsData[chain];
    if (!chainEntry.timestamp || now - chainEntry.timestamp > UPDATE_INTERVAL) {
      const updatedChainData = await fetchChainData(chain);
      if (updatedChainData) {
        chainsData[chain] = updatedChainData;
        logToFile(logModuleName, `Updated data for chain: ${chain}`);
      }
    }
  });

  Promise.all(promises).then(() => {
    saveChainsData(chainsData);
    console.log("Chains data updated.");
    logToFile(logModuleName, "Chains data updated.");
  });
}

fetchChains().then(() => {
  setInterval(checkAndUpdateChains, UPDATE_INTERVAL);
});

export { fetchChainData, checkAndUpdateChains, fetchChains };