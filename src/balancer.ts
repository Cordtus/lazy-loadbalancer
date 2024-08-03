import express, { Request, Response } from 'express';
import { loadChainsData } from './utils.js';
import { balancerLogger as logger } from './logger.js';
import config from './config.js';
import { ChainEntry } from './types.js';
import { HttpsAgent } from 'agentkeepalive';
import { Agent as HttpAgent } from 'http';
import fetch, { RequestInit } from 'node-fetch';
import { requestLogger } from './requestLogger.js';
import { errorHandler } from './errorHandler.js';
import NodeCache from 'node-cache';
import http2 from 'http2';
import { CircuitBreaker } from './circuitBreaker.js';

const app = express();
const PORT = config.port;

const chainsData: Record<string, ChainEntry> = loadChainsData();
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

const httpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000,
});

const httpAgent = new HttpAgent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000,
});

interface EndpointStats {
  address: string;
  weight: number;
  responseTime: number;
}

class WeightedRoundRobin {
  private endpoints: EndpointStats[];
  private currentIndex: number = 0;

  constructor(addresses: string[]) {
    this.endpoints = addresses.map(address => ({
      address,
      weight: 1,
      responseTime: 0,
    }));
  }

  selectNextEndpoint(): string {
    const selected = this.endpoints[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
    return selected.address;
  }

  updateStats(address: string, responseTime: number) {
    const endpoint = this.endpoints.find(e => e.address === address);
    if (endpoint) {
      endpoint.responseTime = responseTime;
      endpoint.weight = 1 / (responseTime || 1); // Avoid division by zero
    }
    this.endpoints.sort((a, b) => b.weight - a.weight);
  }
}

const loadBalancers: Record<string, WeightedRoundRobin> = {};

function selectNextRPC(chain: string): string {
  if (!loadBalancers[chain]) {
    loadBalancers[chain] = new WeightedRoundRobin(chainsData[chain]['rpc-addresses']);
  }
  return loadBalancers[chain].selectNextEndpoint();
}

const circuitBreakers: Record<string, CircuitBreaker> = {};
const http2Sessions: Record<string, http2.ClientHttp2Session> = {};

async function getHttp2Session(url: URL): Promise<http2.ClientHttp2Session> {
  const authority = `${url.protocol}//${url.host}`;
  if (!http2Sessions[authority]) {
    http2Sessions[authority] = http2.connect(authority);
    http2Sessions[authority].on('error', (err) => {
      delete http2Sessions[authority];
      logger.error(`HTTP/2 session error for ${authority}:`, err);
    });
  }
  return http2Sessions[authority];
}

async function proxyRequestHttp2(chain: string, req: Request, res: Response): Promise<void> {
  const rpcAddress = selectNextRPC(chain);
  const url = new URL(rpcAddress);
  const session = await getHttp2Session(url);

  const stream = session.request({
    ':method': req.method,
    ':path': url.pathname + url.search,
    ...req.headers,
  });

  stream.on('response', (headers) => {
    res.writeHead(headers[':status'] as number, headers);
  });

  stream.on('data', (chunk) => {
    res.write(chunk);
  });

  stream.on('end', () => {
    res.end();
  });

  if (req.body) {
    stream.end(JSON.stringify(req.body));
  } else {
    stream.end();
  }
}

async function proxyRequest(chain: string, req: Request, res: Response): Promise<void> {
  const maxAttempts = chainsData[chain]?.['rpc-addresses'].length || 1;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const rpcAddress = selectNextRPC(chain);
    const url = new URL(rpcAddress);

    if (!circuitBreakers[rpcAddress]) {
      circuitBreakers[rpcAddress] = new CircuitBreaker();
    }

    if (circuitBreakers[rpcAddress].isOpen()) {
      attempts++;
      continue;
    }

    logger.debug(`Proxying request to ${url.href} (Attempt ${attempts + 1}/${maxAttempts})`);

    try {
      const fetchOptions: RequestInit = {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          ...Object.fromEntries(
            Object.entries(req.headers)
              .filter(([key]) => !['host', 'content-length'].includes(key.toLowerCase()))
          ),
        },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(config.requestTimeout),
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      };

      const startTime = Date.now();
      const response = await fetch(url.href, fetchOptions);
      const endTime = Date.now();
      const responseTime = endTime - startTime;

      logger.debug(`Response received in ${responseTime}ms with status ${response.status}`);

      if (response.ok) {
        const responseText = await response.text();
        logger.debug(`Response body: ${responseText.substring(0, 200)}...`);

        // Check if the response is valid JSON
        try {
          JSON.parse(responseText);
        } catch (error) {
          logger.error(`Invalid JSON response from ${url.href}`);
          circuitBreakers[rpcAddress].recordFailure();
          attempts++;
          continue;
        }

        // Set safe headers
        for (const [key, value] of response.headers.entries()) {
          if (!['content-encoding', 'content-length'].includes(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        }
        
        loadBalancers[chain].updateStats(rpcAddress, responseTime);
        circuitBreakers[rpcAddress].recordSuccess();
        res.status(response.status).send(responseText);
        return;
      } else {
        logger.error(`Non-OK response from ${url.href}: ${response.status}`);
        circuitBreakers[rpcAddress].recordFailure();
        attempts++;
      }
    } catch (error) {
      logger.error(`Error proxying request to ${url.href}:`, error);
      circuitBreakers[rpcAddress].recordFailure();
      attempts++;
    }
  }

  logger.error(`Failed to proxy request after ${maxAttempts} attempts`);
  res.status(502).send('Unable to process request after multiple attempts');
}

async function proxyRequestWithRetry(chain: string, req: Request, res: Response): Promise<void> {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      await proxyRequest(chain, req, res);
      return;
    } catch (error) {
      retryCount++;
      if (retryCount >= maxRetries) {
        throw error;
      }
      const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function proxyRequestWithCaching(chain: string, req: Request, res: Response): Promise<void> {
  const cacheKey = `${chain}:${req.method}:${req.url}:${JSON.stringify(req.body)}`;
  const cachedResponse = cache.get(cacheKey);

  if (cachedResponse) {
    res.status(200).send(cachedResponse);
    return;
  }

  const originalSend = res.send;
  res.send = function(body) {
    if (req.method === 'GET' || req.method === 'POST') {
      cache.set(cacheKey, body);
    }
    return originalSend.call(this, body);
  };

  await proxyRequestWithRetry(chain, req, res);
}

app.use(express.json());

app.use((req, res, next) => {
  logger.debug(`Incoming request: ${req.method} ${req.url}`);
  logger.debug(`Headers: ${JSON.stringify(req.headers)}`);
  logger.debug(`Body: ${JSON.stringify(req.body)}`);
  next();
});

app.use(express.json());
app.use(requestLogger);

app.all('/lb/:chain', async (req: Request, res: Response) => {
  const { chain } = req.params;

  logger.debug(`Received ${req.method} request for chain: ${chain}`);

  try {
    if (!chainsData[chain]) {
      logger.info(`Chain data for ${chain} not found.`);
      return res.status(404).send(`Chain ${chain} not found.`);
    }

    await proxyRequestWithCaching(chain, req, res);
  } catch (error) {
    logger.error(`Error proxying request for ${chain}:`, error);
    res.status(502).send(`Unable to process request after multiple attempts`);
  }
});

export function startBalancer() {
  const app = express();
  const PORT = config.port;

app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`Load balancer running at http://localhost:${PORT}`);
});
}

export { proxyRequestWithCaching, selectNextRPC };