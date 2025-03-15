// apiExtensions.ts
import express, { Request, Response } from 'express';
import { enhancedCrawlNetwork, enhancedCrawlAllChains, setupScheduledCrawling, getCrawlStats } from './enhancedCrawler.js';
import { Database } from './database.js';
import { appLogger as logger } from './logger.js';
import { metricsHistory } from './metrics.js';

/**
 * Add enhanced crawler endpoints to an existing API router
 * 
 * @param router Express router to extend
 * @param db Database instance
 */
export function addCrawlerEndpoints(router: express.Router, db: Database): void {
  // Get crawl statistics
  router.get('/crawl-stats', (req: Request, res: Response) => {
    try {
      const stats = getCrawlStats();
      res.json(stats);
    } catch (error) {
      logger.error('Error getting crawl stats:', error);
      res.status(500).json({ error: 'Failed to get crawl statistics' });
    }
  });

  // Get metrics for a specific chain
  router.get('/metrics/:chainName', async (req: Request, res: Response) => {
    const { chainName } = req.params;
    
    try {
      const chain = await db.getChain(chainName);
      if (!chain) {
        return res.status(404).json({ error: `Chain ${chainName} not found` });
      }
      
      const metrics = metricsHistory.getChainHistory(chain['chain-id']);
      res.json(metrics);
    } catch (error) {
      logger.error(`Error getting metrics for chain ${chainName}:`, error);
      res.status(500).json({ error: 'Failed to get metrics' });
    }
  });

  // Start scheduled crawling
  router.post('/start-scheduled-crawling', (req: Request, res: Response) => {
    try {
      const interval = req.body.interval || 24 * 60 * 60 * 1000; // Default to 24 hours
      setupScheduledCrawling(interval);
      res.json({ 
        message: `Scheduled crawling started with interval of ${interval / (60 * 60 * 1000)} hours` 
      });
    } catch (error) {
      logger.error('Error starting scheduled crawling:', error);
      res.status(500).json({ error: 'Failed to start scheduled crawling' });
    }
  });

  // Enhanced crawl for a specific chain
  router.post('/enhanced-crawl-chain/:chainName', async (req: Request, res: Response) => {
    const chainName = req.params.chainName;
    
    try {
      const chain = await db.getChain(chainName);
      if (!chain) {
        return res.status(404).json({ error: `Chain ${chainName} not found` });
      }
      
      const results = await enhancedCrawlNetwork(chainName, chain['rpc-addresses']);
      res.json({ 
        message: `Chain ${chainName} successfully crawled`,
        ...results 
      });
    } catch (error) {
      logger.error(`Error during enhanced crawl for ${chainName}:`, error);
      res.status(500).json({ error: `Failed to crawl chain ${chainName}` });
    }
  });

  // Enhanced crawl for all chains
  router.post('/enhanced-crawl-all-chains', async (req: Request, res: Response) => {
    try {
      // Use a timeout to avoid keeping the connection open too long
      const requestTimeout = setTimeout(() => {
        res.json({ 
          message: 'Enhanced crawl for all chains started in the background',
          note: 'This is a long-running process, check /crawl-stats for progress'
        });
      }, 2000);
      
      // Start the crawl in the background
      enhancedCrawlAllChains()
        .then(results => {
          clearTimeout(requestTimeout);
          logger.info('Enhanced crawl for all chains completed');
        })
        .catch(error => {
          clearTimeout(requestTimeout);
          logger.error('Error during enhanced crawl for all chains:', error);
        });
      
    } catch (error) {
      logger.error('Error starting enhanced crawl for all chains:', error);
      res.status(500).json({ error: 'Failed to start crawl for all chains' });
    }
  });

  // Get all endpoints for a specific chain with detailed metadata
  router.get('/enhanced-endpoints/:chainName', async (req: Request, res: Response) => {
    const chainName = req.params.chainName;
    
    try {
      const chain = await db.getChain(chainName);
      if (!chain) {
        return res.status(404).json({ error: `Chain ${chainName} not found` });
      }
      
      const endpoints = await db.getEndpointsByChain(chain['chain-id']);
      
      // Add more readable metadata
      const enhancedEndpoints = endpoints.map(endpoint => ({
        url: endpoint.url,
        lastSeen: new Date(endpoint.lastSeen).toISOString(),
        successRate: `${(endpoint.successRate * 100).toFixed(1)}%`,
        avgLatency: `${endpoint.avgLatency.toFixed(0)}ms`,
        responseCount: endpoint.responseCount,
        failureCount: endpoint.failureCount,
        reliability: endpoint.failureCount === 0 ? 'Perfect' :
                    endpoint.successRate > 0.95 ? 'Excellent' :
                    endpoint.successRate > 0.9 ? 'Good' :
                    endpoint.successRate > 0.8 ? 'Fair' : 'Poor',
        features: endpoint.features
      }));
      
      res.json({
        chainName,
        chainId: chain['chain-id'],
        endpointCount: endpoints.length,
        endpoints: enhancedEndpoints
      });
    } catch (error) {
      logger.error(`Error getting enhanced endpoints for ${chainName}:`, error);
      res.status(500).json({ error: `Failed to get endpoints for ${chainName}` });
    }
  });

  // Health check for the crawler system
  router.get('/crawler-health', (req: Request, res: Response) => {
    try {
      const stats = getCrawlStats();
      const latestMetrics = metricsHistory.getLatestMetrics();
      
      res.json({
        status: 'healthy',
        activeCrawls: stats.currentCrawl.activeWorkers > 0,
        totalEndpoints: stats.history.totalValid,
        lastCrawl: latestMetrics.size > 0 ? 
          new Date(Math.max(...Array.from(latestMetrics.values()).map(m => m.endTime))).toISOString() : 
          'never'
      });
    } catch (error) {
      logger.error('Error during crawler health check:', error);
      res.status(500).json({ 
        status: 'unhealthy',
        error: 'Failed to check crawler health'
      });
    }
  });
}

/**
 * How to use this module to extend your API:
 * 
 * import { addCrawlerEndpoints } from './apiExtensions.js';
 * import database from './database.js';
 * 
 * // In your API setup code:
 * const router = express.Router();
 * addCrawlerEndpoints(router, database);
 * app.use('/api', router);
 */