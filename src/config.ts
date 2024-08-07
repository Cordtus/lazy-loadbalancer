import dotenv from 'dotenv';

dotenv.config();

export const REPO_OWNER = "cosmos";
export const REPO_NAME = "chain-registry";

const config = {
  port: process.env.PORT || 3000,
  requestTimeout: 12000,
  github: {
    pat: process.env.GITHUB_PAT,
    owner: REPO_OWNER,
    repo: REPO_NAME,
  },
  chains: {
    checkInterval: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
  },
  crawler: {
    timeout: 3500,
    retries: 3,
    retryDelay: 1000,
    maxDepth: 3,
    recheckInterval: 24 * 60 * 60 * 1000, // 24 hours
  },
  logging: {
    balancer: 'info',
    crawler: 'info',
    app: 'info'
  }
};

console.log('Config loaded:', config);

export default config;