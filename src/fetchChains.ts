// fetchCHains.ts
import dotenv from "dotenv";
import fetch from "node-fetch";
import config from './config.js';
import { Octokit } from "@octokit/core";
import { ChainEntry, ChainData } from "./types";
import { crawlerLogger as logger } from './logger.js';
import { ensureFilesExist, loadChainsData, saveChainsData } from './utils.js';

dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_PAT,
});

const REPO_OWNER = "cosmos";
const REPO_NAME = "chain-registry";
const UPDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

async function fetchChainData(chain: string): Promise<ChainEntry | null> {
  const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/${chain}/chain.json`;
  logger.debug(`Fetching chain data from URL: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.error(`Failed to fetch data for chain: ${chain}`);
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
    logger.error(`Error fetching data for chain ${chain}:`, error);
    return null;
  }
}

export async function fetchChains() {
  ensureFilesExist();

  try {
    logger.info(`Fetching chains...`);
    const response = await octokit.request(`GET /repos/{owner}/{repo}/contents`, {
      owner: config.github.owner,
      repo: config.github.repo,
    });

    const chainsData: { [key: string]: ChainEntry } = loadChainsData();
    const now = Date.now();

    if (Array.isArray(response.data)) {
      for (const item of response.data) {
        if (
          item.type === "dir" &&
          !item.name.startsWith(".") &&
          !item.name.startsWith("_") &&
          item.name !== "testnets"
        ) {
          const chainEntry = chainsData[item.name];
          if (!chainEntry || !chainEntry.timestamp || now - chainEntry.timestamp > config.chains.checkInterval) {
            const chainData = await fetchChainData(item.name);
            if (chainData) {
              chainsData[item.name] = chainData;
              logger.info(`Fetched and saved data for chain: ${item.name}`);
            }
          }
        }
      }
    }

    saveChainsData(chainsData);
    logger.info(`Chains data saved`);
  } catch (error) {
    logger.error("Error fetching chains data:", error);
  }
}

export function checkAndUpdateChains() {
  const chainsData: { [key: string]: ChainEntry } = loadChainsData();

  const now = Date.now();
  const promises = Object.keys(chainsData).map(async (chain) => {
    const chainEntry = chainsData[chain];
    if (!chainEntry.timestamp || now - chainEntry.timestamp > UPDATE_INTERVAL) {
      const updatedChainData = await fetchChainData(chain);
      if (updatedChainData) {
        chainsData[chain] = updatedChainData;
        logger.info(`Updated data for chain: ${chain}`);
      }
    }
  });

  Promise.all(promises).then(() => {
    saveChainsData(chainsData);
    logger.info("Chains data updated.");
  });
}

// Remove the immediate invocation of fetchChains
// fetchChains().then(() => {
//   setInterval(checkAndUpdateChains, UPDATE_INTERVAL);
// });

export { fetchChainData };