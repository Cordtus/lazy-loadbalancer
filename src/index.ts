// index.ts - Enhanced main application file
import express, { RequestHandler } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import apiRouter from './api.js';
import dataService from './dataService.js';
import { configureLoadBalancer } from './balancer.js';
import { appLogger as logger } from './logger.js';
import config from './config.js';
import { getCacheStats } from './cacheManager.js';
import SchedulerService from './scheduler.js';
import { performance } from 'perf_hooks';

// Application state
let isInitialFetchComplete = false;
let isHealthy = true;

// Initialize scheduler
const scheduler = new SchedulerService({
  isHealthy,
  setHealthy: (healthy: boolean) => { isHealthy = healthy; }
});

async function main() {
  logger.info('Starting application...');
  const startTime = performance.now();

  try {
    // Initialize configuration
    logger.info('Initializing configuration...');
    const globalConfig = config.service.getGlobalConfig();

    // Initial chains data fetch
    logger.info('Fetching initial chain data...');
    try {
      await dataService.fetchChainsFromGitHub();
      isInitialFetchComplete = true;
      logger.info('Initial chain fetch completed successfully.');
    } catch (error) {
      logger.error('Error during initial chain fetch:', error);
      logger.warn('Continuing with potentially stale data. Will retry fetch later.');
    }

    // Create and configure Express app
    const app = express();

    // Apply security and performance middleware
    app.use(
      helmet({
        contentSecurityPolicy: false, // Disable CSP to avoid issues with browser-based API clients
      }) as RequestHandler
    );
    app.use(compression() as unknown as RequestHandler);

    // Configure CORS
    app.use('*', (req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization'
      );
      if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
      }
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
          stats: '/stats',
        },
      });
    });

    // Health check endpoint (unified with balancer health check)
    app.get('/health', (req, res) => {
      const health = {
        status: isHealthy ? 'UP' : 'DEGRADED',
        timestamp: new Date().toISOString(),
        initialFetchComplete: isInitialFetchComplete,
        chains: Object.keys(globalConfig.chains || {}).length,
        cacheStats: getCacheStats(),
        schedulerTasks: scheduler.getStatus(),
        memory: process.memoryUsage(),
      };

      const status = isHealthy ? 200 : 503;
      res.status(status).json(health);
    });

    // Configure the load balancer
    logger.info('Configuring load balancer...');
    await configureLoadBalancer(app);

    // Start the scheduler
    scheduler.start();

    // Start the server
    const PORT = config.port;
    app.listen(PORT, () => {
      logger.info(`Server started successfully at http://localhost:${PORT}`);
    });

    const endTime = performance.now();
    logger.info(`Application started successfully in ${(endTime - startTime).toFixed(2)}ms`);
  } catch (error) {
    logger.error('Fatal error during application startup:', error);
    isHealthy = false;
    process.exit(1);
  }
}


main().catch((error) => {
  logger.error('Unhandled error in main:', error);
  process.exit(1);
});
