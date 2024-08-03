import { Octokit } from "@octokit/core";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { ChainEntry, ChainData } from "./types";
import { ensureFilesExist, logToFile, saveChainsData } from './utils.js';
import { crawlerLogger as logger } from './logger.js';
import config from './config.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_PAT,
});

const REPO_OWNER = "cosmos";
const REPO_NAME = "chain-registry";
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

export async function fetchChains() {
  ensureFilesExist();

  try {
    logger.info(`Fetching chains...`);
    const response = await octokit.request(`GET /repos/{owner}/{repo}/contents`, {
      owner: config.github.owner,
      repo: config.github.repo,
    });

    const chainsData: { [key: string]: ChainEntry } = {};
    const chainList: string[] = [];

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
            chainList.push(item.name);
          }
        }
      }
    }

    // Save the list of all chains
    const chainListPath = path.join(DATA_DIR, 'chain_list.json');
    fs.writeFileSync(chainListPath, JSON.stringify(chainList, null, 2));
    logger.info(`Chain list saved: ${chainList.length} chains`);

    // We don't need to save all chains in a single file anymore
    // saveChainsData(chainsData);
  } catch (error) {
    logger.error("Error fetching chains data:", error);
  }
}

export { fetchChainData };