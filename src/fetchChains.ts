// fetchCHains.ts
import { Octokit } from "@octokit/core";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { ChainEntry, ChainData } from "./types";
import { ensureFilesExist, loadChainsData, saveChainsData } from './utils.js';
import { crawlerLogger as logger } from './logger.js';
import config, { REPO_NAME, REPO_OWNER } from './config.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_PAT,
});

const DATA_DIR = path.join(process.cwd(), 'data');

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

    const chainEntry: ChainEntry = {
      chain_name: data.chain_name,
      'chain-id': data.chain_id,
      bech32_prefix: data.bech32_prefix,
      'account-prefix': data.bech32_prefix,
      'rpc-addresses': data.apis.rpc.map((rpc) => rpc.address),
      timeout: "30s",
      timestamp: Date.now(),
    };

    // Save individual chain file
    const chainFilePath = path.join(DATA_DIR, `${chain}.json`);
    fs.writeFileSync(chainFilePath, JSON.stringify(chainEntry, null, 2));
    logger.info(`Saved data for chain: ${chain}`);

    return chainEntry;
  } catch (error) {
    logger.error(`Error fetching data for chain ${chain}:`, error);
    return null;
  }
}

export async function fetchChains(forceUpdate = false) {
  ensureFilesExist();

  try {
    logger.info(`Fetching chains...`);
    const response = await octokit.request(`GET /repos/{owner}/{repo}/contents`, {
      owner: config.github.owner,
      repo: config.github.repo,
    });

    const existingChainsData = loadChainsData();
    const now = Date.now();
    const updateInterval = config.chains.checkInterval;

    if (Array.isArray(response.data)) {
      for (const item of response.data) {
        if (
          item.type === "dir" &&
          !item.name.startsWith(".") &&
          !item.name.startsWith("_") &&
          item.name !== "testnets"
        ) {
          const existingChainEntry = existingChainsData[item.name];
          if (forceUpdate || !existingChainEntry || !existingChainEntry.timestamp || now - existingChainEntry.timestamp > updateInterval) {
            const chainData = await fetchChainData(item.name);
            if (chainData) {
              existingChainsData[item.name] = chainData;
              logger.info(`Fetched and saved data for chain: ${item.name}`);
            }
          } else {
            logger.info(`Chain ${item.name} data is up to date.`);
          }
        }
      }
    }

    saveChainsData(existingChainsData);
    logger.info(`Chains data saved`);
  } catch (error) {
    logger.error("Error fetching chains data:", error);
  }
}

export async function updateSingleChain(chainName: string): Promise<boolean> {
  try {
    const chainData = await fetchChainData(chainName);
    if (chainData) {
      const chainsData = loadChainsData();
      chainsData[chainName] = chainData;
      saveChainsData(chainsData);
      logger.info(`Updated data for chain: ${chainName}`);
      return true;
    }
    return false;
  } catch (error) {
    logger.error(`Error updating chain ${chainName}:`, error);
    return false;
  }
}

export { fetchChainData };