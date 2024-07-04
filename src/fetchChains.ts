import { Octokit } from "@octokit/core";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { ChainEntry, ChainData } from "./types";
import { ensureFilesExist, loadChainsData, saveChainsData, logToFile, getDirName } from './utils.js';

dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_PAT,
});

const REPO_OWNER = "cosmos";
const REPO_NAME = "chain-registry";
const UPDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days

const logModuleName = 'fetchChains';

async function fetchChainData(chain: string): Promise<ChainEntry | null> {
  const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/${chain}/chain.json`;

  try {
    logToFile(logModuleName, `Fetching data for chain: ${chain}`);
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
  ensureFilesExist();  // Ensure file exists before starting

  try {
    logToFile(logModuleName, `Fetching chains...`);
    const response = await octokit.request(`GET /repos/{owner}/{repo}/contents`, {
      owner: REPO_OWNER,
      repo: REPO_NAME,
    });

    const chainsData: { [key: string]: ChainEntry } = {};

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
            logToFile(logModuleName, `Fetched and saved data for chain: ${item.name}`);
          }
        }
      }
    }

    saveChainsData(chainsData);
    console.log("Chains data saved.");
    logToFile(logModuleName, "Chains data saved.");
  } catch (error) {
    console.error("Error fetching chains data:", error);
    logToFile(logModuleName, `Error fetching chains data: ${error}`);
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

export { fetchChainData, checkAndUpdateChains };
