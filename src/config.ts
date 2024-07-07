import dotenv from 'dotenv';

dotenv.config();

export default {
  port: process.env.PORT || 3000,
  requestTimeout: 5000,
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
    timeout: 5000, // increased to 5 seconds
    maxDepth: 3,
    recheckInterval: 24 * 60 * 60 * 1000, // 24 hours
  },
  logging: {
    balancer: process.env.LOG_LEVEL_BALANCER || 'info',
    crawler: process.env.LOG_LEVEL_CRAWLER || 'info',
    app: process.env.LOG_LEVEL_APP || 'info',
  }
};