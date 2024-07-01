import { Octokit } from "@octokit/core";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const octokit = new Octokit({
  auth: process.env.GITHUB_PAT,
});

const REPO_OWNER = "cosmos";
const REPO_NAME = "chain-registry";
const OUTPUT_FILE = "data/chains.json";

interface ChainData {
  chain_name: string;
  rpc_addresses: string[];
}

async function fetchChains() {
  try {
    const response = await octokit.request(`GET /repos/{owner}/{repo}/contents`, {
      owner: REPO_OWNER,
      repo: REPO_NAME,
    });

    const chainsData: { [key: string]: ChainData } = {};
    if (Array.isArray(response.data)) {
      response.data.forEach((item) => {
        if (
          item.type === "dir" &&
          !item.name.startsWith(".") &&
          !item.name.startsWith("_") &&
          item.name !== "testnets"
        ) {
          chainsData[item.name] = { chain_name: item.name, rpc_addresses: [] };
        }
      });
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(chainsData, null, 2));
    console.log("Chains data saved.");
  } catch (error) {
    console.error("Error fetching chains data:", error);
  }
}

fetchChains();
