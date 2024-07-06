import dotenv from 'dotenv';

dotenv.config();

const config = {
  port: process.env.PORT || 3000,
  github: {
    pat: process.env.GITHUB_PAT,
    owner: 'cosmos',
    repo: 'chain-registry',
  },
  chains: {
    updateInterval: 7 * 24 * 60 * 60 * 1000, // 7 days
    checkInterval: 24 * 60 * 60 * 1000, // 24 hours
  },
  crawler: {
    timeout: 3000,
    maxDepth: 3,
    recheckInterval: 24 * 60 * 60 * 1000, // 24 hours
  },
};

export default config;