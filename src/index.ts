// index.ts - Enhanced main application file
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import apiRouter from './api.js';
import { fetchChains } from './fetchChains.js';
import { startBalancer } from './balancer.js';
import { appLogger as logger } from './logger.js';
import configService from './configService.js';
import { getCacheStats } from './cacheManager.js';
import { scheduleJob } from 'node-schedule';
import { cleanupBlacklist } from './utils.js';
import { crawlAllChains } from './crawler.js';
import { performance } from 'perf_hooks';

// Application state
let isInitialFetchComplete = false;
let isHealthy = true;

async function main() {
  logger.info('Starting application...');
  const startTime = performance.now();
  
  try {
    // Initialize configuration
    logger.info('Initializing configuration...');
    const globalConfig = configService.getGlobalConfig();
    
    // Initial chains data fetch
    logger.info('Fetching initial chain data...');
    try {
      await fetchChains(false);
      isInitialFetchComplete = true;
      logger.info('Initial chain fetch completed successfully.');
    } catch (error) {
      logger.error('Error during initial chain fetch:', error);
      logger.warn('Continuing with potentially stale data. Will retry fetch later.');
    }
    
    // Create and configure Express app
    const app = express();
    
    // Apply security and performance middleware
    app.use(helmet({
      contentSecurityPolicy: false // Disable CSP to avoid issues with browser-based API clients
    }));
    app.use(compression()); // Compress all responses
    
    // Configure CORS
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
      }
      next();
    });
    
    // Basic request logging for all requests
    app.use((req, res, next) => {
      const start = performance.now();
      res.on('finish', () => {
        const duration = performance.now() - start;
        logger.debug(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration.toFixed(2)}ms`);
      });
      next();
    });
    
    // API endpoints
    app.use('/api', apiRouter);
    
    // Root endpoint provides basic info
    app.get('/', (req, res) => {
      res.json({
        name: 'Cosmos SDK Load Balancer',
        version: '2.0.0',
        status: isHealthy ? 'healthy' : 'degraded',
        initialFetchComplete: isInitialFetchComplete,
        endpoints: {
          api: '/api',
          loadBalancer: '/lb',
          health: '/health',
          stats: '/stats'
        }
      });
    });
    
    // Health check endpoint
    app.get('/health', (req, res) => {
      const health = {
        status: isHealthy ? 'UP' : 'DEGRADED',
        timestamp: new Date().toISOString(),
        initialFetchComplete: isInitialFetchComplete,
        cacheStats: getCacheStats(),
        memory: process.memoryUsage()
      };
      
      const status = isHealthy ? 200 : 503;
      res.status(status).json(health);
    });
    
    // Start the load balancer
    logger.info('Starting load balancer...');
    startBalancer(app);
    
    // Schedule recurring tasks
    setupScheduledTasks();
    
    const endTime = performance.now();
    logger.info(`Application started successfully in ${(endTime - startTime).toFixed(2)}ms`);
    
  } catch (error) {
    logger.error('Fatal error during application startup:', error);
    isHealthy = false;
    process.exit(1);
  }
}

function setupScheduledTasks() {
  // Schedule chain data refresh - every 12 hours
  scheduleJob('0 */12 * * *', async () => {
    logger.info('Running scheduled chain data refresh...');
    try {
      const startTime = performance.now();
      await fetchChains(true);
      const endTime = performance.now();
      logger.info(`Scheduled chain data refresh completed in ${(endTime - startTime).toFixed(2)}ms`);
    } catch (error) {
      logger.error('Error during scheduled chain data refresh:', error);
      isHealthy = false; // Mark system as degraded
    }
  });
  
  // Schedule blacklist cleanup - every hour
  scheduleJob('0 * * * *', () => {
    logger.info('Running scheduled blacklist cleanup...');
    try {
      const result = cleanupBlacklist();
      logger.info(`Blacklist cleanup completed: ${result.cleaned} items removed, ${result.remaining} items remaining`);
    } catch (error) {
      logger.error('Error during scheduled blacklist cleanup:', error);
    }
  });
  
  // Schedule network crawl - every 24 hours
  scheduleJob('0 0 * * *', async () => {
    logger.info('Running scheduled network crawl...');
    try {
      const startTime = performance.now();
      const results = await crawlAllChains();
      const endTime = performance.now();
      
      // Log summary of results
      const totalNewEndpoints = Object.values(results).reduce((sum, result) => sum + result.newEndpoints, 0);
      logger.info(
        `Scheduled network crawl completed in ${(endTime - startTime).toFixed(2)}ms. ` +
        `Discovered ${totalNewEndpoints} new endpoints.`
      );
    } catch (error) {
      logger.error('Error during scheduled network crawl:', error);
    }
  });
  
  // Health check recovery - every 5 minutes
  scheduleJob('*/5 * * * *', async () => {
    if (!isHealthy) {
      logger.info('System is in degraded state, attempting recovery...');
      try {
        // Try to refresh chain data if initial fetch failed
        if (!isInitialFetchComplete) {
          await fetchChains(true);
          isInitialFetchComplete = true;
        }
        
        // Mark system as healthy again
        isHealthy = true;
        logger.info('System recovery successful, health restored');
      } catch (error) {
        logger.error('Recovery attempt failed:', error);
      }
    }
  });
  
  logger.info('Scheduled tasks setup complete');
}

main().catch(error => {
  logger.error('Unhandled error in main:', error);
  process.exit(1);
});