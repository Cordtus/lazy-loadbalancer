// Enhanced balancer.ts
import express, { Express, Request, Response } from 'express';
import dataService from './dataService.js';
import { balancerLogger as logger } from './logger.js';
import config from './config.js';
import { ChainEntry, EndpointStats, LoadBalancerStrategy, RouteConfig } from './types.js';
import { HttpsAgent } from 'agentkeepalive';
import { Agent as HttpAgent } from 'http';
import fetch, { RequestInit } from 'node-fetch';
import { requestLogger } from './requestLogger.js';
import { errorHandler } from './errorHandler.js';
import { cacheManager, sessionCache, getCacheStats } from './cacheManager.js';
import http2 from 'http2';
import { CircuitBreaker } from './circuitBreaker.js';
import { performance } from 'perf_hooks';
import crypto from 'crypto';

let chainsData: Record<string, ChainEntry> = {};

// Initialize chains data
async function initializeChainsData() {
  chainsData = await dataService.loadChainsData();
}

// Agent pool optimization: reuse agents for better connection management
const agentPool = {
  https: new HttpsAgent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000,
  }),
  http: new HttpAgent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 60000,
  }),
};

class LoadBalancer {
  private endpoints: EndpointStats[];
  private currentIndex: number = 0;
  private strategy: LoadBalancerStrategy;
  private routeConfig: RouteConfig | null;
  private activeConnections: Map<string, number>;

  constructor(
    addresses: string[],
    strategy: LoadBalancerStrategy,
    routeConfig: RouteConfig | null
  ) {
    this.endpoints = addresses.map((address) => ({
      address,
      weight: 1,
      responseTime: 0,
      successCount: 0,
      failureCount: 0,
    }));
    this.strategy = strategy;
    this.routeConfig = routeConfig;
    this.activeConnections = new Map<string, number>();
  }

  selectNextEndpoint(req: Request): string {
    // Apply endpoint filters if specified in the route config
    let filteredEndpoints = [...this.endpoints];

    if (this.routeConfig?.filters) {
      if (this.routeConfig.filters.whitelist && this.routeConfig.filters.whitelist.length > 0) {
        filteredEndpoints = filteredEndpoints.filter((e) =>
          this.routeConfig?.filters?.whitelist?.some((pattern) =>
            this.matchesPattern(e.address, pattern)
          )
        );
      }

      if (this.routeConfig.filters.blacklist && this.routeConfig.filters.blacklist.length > 0) {
        filteredEndpoints = filteredEndpoints.filter(
          (e) =>
            !this.routeConfig?.filters?.blacklist?.some((pattern) =>
              this.matchesPattern(e.address, pattern)
            )
        );
      }
    }

    // If filtered list is empty, use the original endpoints as fallback
    if (filteredEndpoints.length === 0) {
      filteredEndpoints = this.endpoints;
      logger.warn(`Filtered endpoint list is empty, falling back to all endpoints`);
    }

    // Check if sticky sessions are enabled for this route
    if (this.routeConfig?.sticky) {
      const clientIp = this.getClientIp(req);
      const sessionKey = `${req.params.chain}:${clientIp}`;

      // Check if we have a session for this client
      const existingSession = sessionCache.get<string>(sessionKey);
      if (existingSession) {
        // Check if the endpoint from the session is still in our filtered list
        const sessionEndpoint = filteredEndpoints.find((e) => e.address === existingSession);
        if (sessionEndpoint) {
          return sessionEndpoint.address;
        }
      }

      // If no valid session exists, create a new one
      const selectedEndpoint = this.selectEndpointByStrategy(filteredEndpoints, req);
      sessionCache.set(sessionKey, selectedEndpoint);
      return selectedEndpoint;
    }

    // If not sticky, just select by strategy
    return this.selectEndpointByStrategy(filteredEndpoints, req);
  }

  private matchesPattern(address: string, pattern: string): boolean {
    if (pattern.includes('*') || pattern.includes('?')) {
      const regexPattern = pattern
        .replace(/\./g, '\\.') // Escape dots
        .replace(/\*/g, '.*') // * becomes .*
        .replace(/\?/g, '.'); // ? becomes .

      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(address);
    }

    return address.includes(pattern);
  }

  private getClientIp(req: Request): string {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      return Array.isArray(forwardedFor)
        ? forwardedFor[0].split(',')[0].trim()
        : forwardedFor.split(',')[0].trim();
    }
    return req.socket.remoteAddress || '0.0.0.0';
  }

  private selectEndpointByStrategy(endpoints: EndpointStats[], req: Request): string {
    switch (this.strategy.type) {
      case 'round-robin':
        return this.roundRobinStrategy(endpoints);
      case 'weighted':
        return this.weightedStrategy(endpoints);
      case 'least-connections':
        return this.leastConnectionsStrategy(endpoints);
      case 'random':
        return this.randomStrategy(endpoints);
      case 'ip-hash':
        return this.ipHashStrategy(endpoints, req);
      default:
        return this.weightedStrategy(endpoints);
    }
  }

  private roundRobinStrategy(endpoints: EndpointStats[]): string {
    const selected = endpoints[this.currentIndex % endpoints.length];
    this.currentIndex = (this.currentIndex + 1) % endpoints.length;
    return selected.address;
  }

  private weightedStrategy(endpoints: EndpointStats[]): string {
    // Sort by weight (highest weight first)
    const sortedEndpoints = [...endpoints].sort((a, b) => b.weight - a.weight);

    // Use weighted randomization
    const totalWeight = sortedEndpoints.reduce((sum, endpoint) => sum + endpoint.weight, 0);
    let random = Math.random() * totalWeight;

    for (const endpoint of sortedEndpoints) {
      random -= endpoint.weight;
      if (random <= 0) {
        return endpoint.address;
      }
    }

    // Fallback to first endpoint if something goes wrong
    return sortedEndpoints[0].address;
  }

  private leastConnectionsStrategy(endpoints: EndpointStats[]): string {
    // Find endpoint with least active connections
    let minConnections = Number.MAX_SAFE_INTEGER;
    let selectedEndpoint = endpoints[0];

    for (const endpoint of endpoints) {
      const connections = this.activeConnections.get(endpoint.address) || 0;
      if (connections < minConnections) {
        minConnections = connections;
        selectedEndpoint = endpoint;
      }
    }

    // Increment connection counter
    this.activeConnections.set(
      selectedEndpoint.address,
      (this.activeConnections.get(selectedEndpoint.address) || 0) + 1
    );

    return selectedEndpoint.address;
  }

  private randomStrategy(endpoints: EndpointStats[]): string {
    const randomIndex = Math.floor(Math.random() * endpoints.length);
    return endpoints[randomIndex].address;
  }

  private ipHashStrategy(endpoints: EndpointStats[], req: Request): string {
    const clientIp = this.getClientIp(req);

    // Create a hash from the IP
    const hash = crypto.createHash('md5').update(clientIp).digest('hex');

    // Convert to number and use modulo to get an index
    const hashNum = parseInt(hash.substring(0, 8), 16);
    const index = hashNum % endpoints.length;

    return endpoints[index].address;
  }

  updateStats(address: string, responseTime: number, success: boolean) {
    const endpoint = this.endpoints.find((e) => e.address === address);
    if (endpoint) {
      // Update response time with weighted average (80% old, 20% new)
      endpoint.responseTime =
        endpoint.responseTime === 0
          ? responseTime
          : 0.8 * endpoint.responseTime + 0.2 * responseTime;

      // Update weight based on response time and success rate
      const successRate =
        endpoint.successCount / (endpoint.successCount + endpoint.failureCount + 1);
      const normalizedResponseTime = Math.min(responseTime, 5000) / 5000; // Normalize to 0-1 range

      // Weight formula: higher success rate and lower response time = higher weight
      endpoint.weight = successRate * 0.7 + (1 - normalizedResponseTime) * 0.3;

      // Update success/failure counters
      if (success) {
        endpoint.successCount++;
      } else {
        endpoint.failureCount++;
      }

      // Clean up connection counter for least-connections strategy
      const connections = this.activeConnections.get(address) || 0;
      if (connections > 0) {
        this.activeConnections.set(address, connections - 1);
      }
    }
  }

  getStats(): EndpointStats[] {
    return this.endpoints;
  }
}

const loadBalancers: Record<string, Record<string, LoadBalancer>> = {};
const circuitBreakers: Record<string, CircuitBreaker> = {};
const http2Sessions: Record<string, http2.ClientHttp2Session> = {};

export function selectNextRPC(chain: string, req: Request, pathWithoutChain: string): string {
  // Get route-specific configuration
  const routeConfig = config.service.getEffectiveRouteConfig(chain, pathWithoutChain);
  const routeKey = routeConfig.path;

  // Initialize chain-specific balancers if not exists
  if (!loadBalancers[chain]) {
    loadBalancers[chain] = {};
  }

  // Initialize or update route-specific balancer if needed
  if (!loadBalancers[chain][routeKey]) {
    loadBalancers[chain][routeKey] = new LoadBalancer(
      chainsData[chain]['rpc-addresses'],
      routeConfig.strategy || { type: 'weighted' },
      routeConfig
    );
  }

  return loadBalancers[chain][routeKey].selectNextEndpoint(req);
}

async function getHttp2Session(url: URL): Promise<http2.ClientHttp2Session> {
  const authority = `${url.protocol}//${url.host}`;
  if (!http2Sessions[authority] || http2Sessions[authority].closed) {
    http2Sessions[authority] = http2.connect(authority);
    http2Sessions[authority].on('error', (err) => {
      delete http2Sessions[authority];
      logger.error(`HTTP/2 session error for ${authority}:`, err);
    });
  }
  return http2Sessions[authority];
}

async function proxyRequestHttp2(chain: string, req: Request, res: Response): Promise<void> {
  const pathWithoutChain = '/' + req.path.split('/').slice(3).join('/');
  const rpcAddress = selectNextRPC(chain, req, pathWithoutChain);
  const url = new URL(rpcAddress);
  const session = await getHttp2Session(url);

  const headers = {
    ':method': req.method,
    ':path': url.pathname + url.search,
    ...req.headers,
  };

  const stream = session.request(headers);

  stream.on('response', (headers) => {
    res.writeHead(headers[':status'] as number, headers);
  });

  stream.on('data', (chunk) => {
    res.write(chunk);
  });

  stream.on('end', () => {
    res.end();
  });

  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
    stream.end(JSON.stringify(req.body));
  } else {
    stream.end();
  }
}

async function proxyRequest(chain: string, req: Request, res: Response): Promise<void> {
  const pathWithoutChain = '/' + req.path.split('/').slice(3).join('/');
  const routeConfig = config.service.getEffectiveRouteConfig(chain, pathWithoutChain);
  const maxAttempts = routeConfig.retries || chainsData[chain]?.['rpc-addresses'].length || 1;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const rpcAddress = selectNextRPC(chain, req, pathWithoutChain);
    const routeKey = routeConfig.path;
    const url = new URL(rpcAddress);

    url.pathname = url.pathname.replace(/\/?$/, '/') + req.path.split('/').slice(3).join('/');

    if (!circuitBreakers[rpcAddress]) {
      circuitBreakers[rpcAddress] = new CircuitBreaker();
    }

    if (circuitBreakers[rpcAddress].isOpen()) {
      attempts++;
      continue;
    }

    logger.debug(`Proxying request to ${url.href} (Attempt ${attempts + 1}/${maxAttempts})`);

    const startTime = performance.now();

    try {
      const headerObj: Record<string, string> = {};
      const reqHeaders = req.headers as Record<string, string>;
      for (const key in reqHeaders) {
        if (reqHeaders[key]) {
          headerObj[key] = reqHeaders[key];
        }
      }
      headerObj['host'] = url.host;

      const fetchOptions: RequestInit = {
        method: req.method,
        headers: headerObj,
        signal: AbortSignal.timeout(routeConfig.timeoutMs || config.requestTimeout),
        agent: url.protocol === 'https:' ? agentPool.https : agentPool.http,
      };

      if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
        fetchOptions.body = JSON.stringify(req.body);
      }

      const response = await fetch(url.href, fetchOptions);
      const endTime = performance.now();
      const responseTime = endTime - startTime;

      logger.debug(`Response received in ${responseTime}ms with status ${response.status}`);

      if (response.ok) {
        const responseText = await response.text();
        logger.debug(`Response body: ${responseText.substring(0, 200)}...`);

        try {
          JSON.parse(responseText);
        } catch (error) {
          logger.error(`Invalid JSON response from ${url.href}`);
          circuitBreakers[rpcAddress].recordFailure();
          loadBalancers[chain][routeKey].updateStats(rpcAddress, responseTime, false);
          attempts++;
          continue;
        }

        for (const [key, value] of response.headers.entries()) {
          if (!['content-encoding', 'content-length'].includes(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        }

        loadBalancers[chain][routeKey].updateStats(rpcAddress, responseTime, true);
        circuitBreakers[rpcAddress].recordSuccess();
        res.status(response.status).send(responseText);
        return;
      } else {
        logger.error(`Non-OK response from ${url.href}: ${response.status}`);
        circuitBreakers[rpcAddress].recordFailure();
        loadBalancers[chain][routeKey].updateStats(rpcAddress, responseTime, false);
        attempts++;
      }
    } catch (error) {
      const endTime = performance.now();
      const responseTime = endTime - startTime;
      logger.error(`Error proxying request to ${url.href}:`, error);
      circuitBreakers[rpcAddress].recordFailure();
      loadBalancers[chain][routeKey].updateStats(rpcAddress, responseTime, false);
      attempts++;

      // Apply exponential backoff for retries
      if (attempts < maxAttempts) {
        const backoffMultiplier = routeConfig.backoffMultiplier || 1.5;
        const delay = Math.min(1000 * Math.pow(backoffMultiplier, attempts), 10000); // Cap at 10 seconds
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.error(`Failed to proxy request after ${maxAttempts} attempts`);
  res.status(502).send('Unable to process request after multiple attempts');
}

async function proxyRequestWithCaching(chain: string, req: Request, res: Response): Promise<void> {
  const pathWithoutChain = '/' + req.path.split('/').slice(3).join('/');
  const routeConfig = config.service.getEffectiveRouteConfig(chain, pathWithoutChain);
  const cacheConfig = routeConfig.caching;
  const cacheKey = `${chain}:${req.method}:${req.url}:${JSON.stringify(req.body)}`;

  // Check if caching is enabled for this route
  const shouldCache =
    cacheConfig?.enabled &&
    (req.method === 'GET' ||
      (req.method === 'POST' &&
        req.body &&
        ['block', 'tx', 'validators', 'status'].some((method) =>
          req.body.method?.includes(method)
        )));

  if (shouldCache) {
    const cachedResponse = cacheManager.get<string>(cacheKey);
    if (cachedResponse) {
      logger.debug(`Cache hit for ${cacheKey}`);
      res.status(200).send(cachedResponse);
      return;
    }
    logger.debug(`Cache miss for ${cacheKey}`);
  }

  const originalSend = res.send;
  res.send = function (body) {
    if (shouldCache && res.statusCode >= 200 && res.statusCode < 300) {
      cacheManager.set(cacheKey, body, cacheConfig?.ttl);
      logger.debug(`Cached response for ${cacheKey} with TTL ${cacheConfig?.ttl}s`);
    }
    return originalSend.call(this, body);
  };

  await proxyRequest(chain, req, res);
}

export async function configureLoadBalancer(app: Express) {
  // Initialize chains data
  await initializeChainsData();

  // Add load balancer specific middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(requestLogger);

  // Add config API endpoints
  app.get('/config/global', (req: Request, res: Response) => {
    res.json(config.service.getGlobalConfig());
  });

  app.put('/config/global', (req: Request, res: Response) => {
    try {
      config.service.saveGlobalConfig(req.body);
      res.json({ success: true, message: 'Global configuration updated' });
    } catch (error) {
      logger.error('Error updating global config:', error);
      res.status(500).json({ success: false, message: 'Failed to update global configuration' });
    }
  });

  app.get('/config/chain/:chainName', (req: Request, res: Response) => {
    const { chainName } = req.params;
    const chainConfig = config.service.getChainConfig(chainName);
    if (chainConfig) {
      res.json(chainConfig);
    } else {
      res
        .status(404)
        .json({ success: false, message: `No configuration found for chain ${chainName}` });
    }
  });

  app.put('/config/chain/:chainName', (req: Request, res: Response) => {
    const { chainName } = req.params;
    try {
      config.service.saveChainConfig(chainName, req.body);
      res.json({ success: true, message: `Configuration for chain ${chainName} updated` });
    } catch (error) {
      logger.error(`Error updating config for chain ${chainName}:`, error);
      res
        .status(500)
        .json({ success: false, message: `Failed to update configuration for chain ${chainName}` });
    }
  });

  // Add route-specific configuration endpoint
  app.put('/config/chain/:chainName/route', (req: Request, res: Response) => {
    const { chainName } = req.params;
    const { path, ...routeConfig } = req.body;

    if (!path) {
      return res
        .status(400)
        .json({ success: false, message: 'Path is required for route configuration' });
    }

    try {
      const chainConfig =
        config.service.getChainConfig(chainName) ||
        config.service.createDefaultChainConfig(chainName);

      if (!chainConfig.routes) {
        chainConfig.routes = [];
      }

      // Update existing route or add new one
      const existingRouteIndex = chainConfig.routes.findIndex((r) => r.path === path);
      if (existingRouteIndex >= 0) {
        chainConfig.routes[existingRouteIndex] = { path, ...routeConfig };
      } else {
        chainConfig.routes.push({ path, ...routeConfig });
      }

      config.service.saveChainConfig(chainName, chainConfig);
      res.json({ success: true, message: `Route configuration for ${chainName}:${path} updated` });
    } catch (error) {
      logger.error(`Error updating route config for ${chainName}:${path}:`, error);
      res.status(500).json({ success: false, message: 'Failed to update route configuration' });
    }
  });

  // Delete route configuration
  app.delete('/config/chain/:chainName/route/:path', (req: Request, res: Response) => {
    const { chainName, path } = req.params;
    try {
      const chainConfig = config.service.getChainConfig(chainName);
      if (!chainConfig || !chainConfig.routes) {
        return res
          .status(404)
          .json({ success: false, message: 'Chain or route configuration not found' });
      }

      chainConfig.routes = chainConfig.routes.filter((r) => r.path !== path);
      config.service.saveChainConfig(chainName, chainConfig);
      res.json({ success: true, message: `Route configuration for ${chainName}:${path} deleted` });
    } catch (error) {
      logger.error(`Error deleting route config for ${chainName}:${path}:`, error);
      res.status(500).json({ success: false, message: 'Failed to delete route configuration' });
    }
  });

  // Clear route-specific cache
  app.delete('/cache/:chain/:path?', (req: Request, res: Response) => {
    const { chain, path } = req.params;
    const pattern = path ? `${chain}:.*${path}` : `${chain}:`;
    const deletedCount = cacheManager.flush(pattern);
    res.json({ success: true, deletedCount });
  });

  // Main load balancer endpoints
  app.all('/lb/:chain/*', async (req: Request, res: Response) => {
    const { chain } = req.params;

    logger.debug(`Received ${req.method} request for chain: ${chain}`);

    try {
      if (!chainsData[chain]) {
        logger.info(`Chain data for ${chain} not found.`);
        return res.status(404).send(`Chain ${chain} not found.`);
      }

      // Check if HTTP/2 should be used (based on future improvements)
      // For now, always use HTTP/1.1
      await proxyRequestWithCaching(chain, req, res);
    } catch (error) {
      logger.error(`Error proxying request for ${chain}:`, error);
      res
        .status(502)
        .send(
          `Unable to process request: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
  });

  // Enhanced stats endpoint
  app.get('/stats', (req: Request, res: Response) => {
    const stats: Record<string, Record<string, EndpointStats[]>> = {};

    for (const [chain, routeBalancers] of Object.entries(loadBalancers)) {
      stats[chain] = {};
      for (const [routeKey, balancer] of Object.entries(routeBalancers)) {
        stats[chain][routeKey] = balancer.getStats();
      }
    }

    res.json(stats);
  });

  // Chain-specific stats
  app.get('/stats/:chain', (req: Request, res: Response) => {
    const { chain } = req.params;
    if (!loadBalancers[chain]) {
      return res
        .status(404)
        .json({ success: false, message: `No stats available for chain ${chain}` });
    }

    const chainStats: Record<string, EndpointStats[]> = {};
    for (const [routeKey, balancer] of Object.entries(loadBalancers[chain])) {
      chainStats[routeKey] = balancer.getStats();
    }

    res.json(chainStats);
  });


  app.use(errorHandler);

  logger.info('Load balancer configuration completed');
}

export { proxyRequestWithCaching, LoadBalancer };
