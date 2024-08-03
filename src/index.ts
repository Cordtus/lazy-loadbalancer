import express from 'express';
import apiRouter from './api.js';
import { fetchChains } from './fetchChains.js';
import { startBalancer } from './balancer.js';
import { appLogger as logger } from './logger.js';

const app = express();

app.use('/api', apiRouter);

async function main() {
  logger.info('Starting application...');
  try {
    await fetchChains();
    logger.info('Initial chain fetch completed.');
    startBalancer(app);  // Pass the app to startBalancer
    logger.info('Balancer started successfully.');
  } catch (error) {
    logger.error('Error during application startup:', error);
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Unhandled error in main:', error);
  process.exit(1);
});