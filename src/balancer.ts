import express, { Request, Response } from 'express';
import { loadChainsData, saveChainsData, ensureFilesExist, loadBlacklistedIPs, saveBlacklistedIPs } from './utils.js';
import { balancerLogger as logger } from './logger.js';
import config from './config.js';
import { ChainEntry } from './types.js';
import https from 'https';
import fetch, { RequestInit } from 'node-fetch';
import apiRouter from './api.js';
import { IncomingHttpHeaders } from 'http';

const app = express();
const PORT = config.port;

ensureFilesExist();

let chainsData: Record<string, ChainEntry> = loadChainsData();
const rpcIndexMap: Record<string, number> = {};
let blacklistedIPs: Record<string, number> = {};

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const BLACKLIST_DURATION = 7 * 24 * 60 * 60 * 1000; // 1 week in milliseconds
const MAX_CONSECUTIVE_FAILURES = 3;

// RPC performance tracking
const rpcPerformance: Record<string, { totalTime: number; requests: number; lastUsed: number }> = {};

function updateRPCPerformance(url: string, time: number) {
  if (!rpcPerformance[url]) {
    rpcPerformance[url] = { totalTime: 0, requests: 0, lastUsed: 0 };
  }
  rpcPerformance[url].totalTime += time;
  rpcPerformance[url].requests += 1;
  rpcPerformance[url].lastUsed = Date.now();
}

function logRPCPerformance() {
  for (const [url, performance] of Object.entries(rpcPerformance)) {
    const avgTime = performance.totalTime / performance.requests;
    logger.info(`RPC ${url} average response time: ${avgTime.toFixed(2)}ms over ${performance.requests} requests`);
  }
}

setInterval(logRPCPerformance, 60000); // Log performance every minute

// Add the refreshChainsData function
function refreshChainsData() {
  chainsData = loadChainsData();
  logger.info('Chains data refreshed');
}

// Improved RPC selection logic
function selectBestRPC(chain: string): string {
  const rpcAddresses = chainsData[chain]?.['rpc-addresses'];
  if (!rpcAddresses || rpcAddresses.length === 0) {
    throw new Error('No RPC addresses available for the specified chain.');
  }

  const now = Date.now();
  let bestRPC = rpcAddresses[0];
  let bestScore = -Infinity;

  for (const rpc of rpcAddresses) {
    const performance = rpcPerformance[rpc] || { totalTime: 0, requests: 1, lastUsed: 0 };
    const avgResponseTime = performance.totalTime / performance.requests;
    const timeSinceLastUse = now - performance.lastUsed;
    
    // Score based on average response time and time since last use
    const score = (1 / avgResponseTime) * timeSinceLastUse;
    
    if (score > bestScore) {
      bestScore = score;
      bestRPC = rpc;
    }
  }

  return bestRPC;
}

async function proxyRequest(chain: string, endpoint: string, req: Request, res: Response): Promise<void> {
  const rpcAddress = selectBestRPC(chain);
  const url = new URL(rpcAddress);
  
  // Only append the endpoint if it's not empty
  if (endpoint) {
    url.pathname = url.pathname.replace(/\/$/, '') + '/' + endpoint.replace(/^\//, '');
  }

  logger.debug(`Proxying request to ${url.href}`);

  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Host': url.hostname,
        ...Object.fromEntries(
          Object.entries(req.headers)
            .filter(([key]) => !['host', 'content-length'].includes(key.toLowerCase()))
        ),
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(config.requestTimeout),
      agent: httpsAgent,
    };

    const startTime = Date.now();
    const response = await fetch(url.href, fetchOptions);
    const endTime = Date.now();
    
    updateRPCPerformance(rpcAddress, endTime - startTime);

    logger.debug(`Response received in ${endTime - startTime}ms with status ${response.status}`);

    if (response.ok) {
      const responseText = await response.text();
      logger.debug(`Response body: ${responseText.substring(0, 200)}...`);

      // Set safe headers
      for (const [key, value] of response.headers.entries()) {
        if (!['content-encoding', 'content-length'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }
      
      res.status(response.status).send(responseText);
    } else {
      logger.error(`Non-OK response from ${url.href}: ${response.status}`);
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (error) {
    logger.error(`Error proxying request to ${url.href}:`, error);
    res.status(502).send('Unable to process request');
  }
}

app.use(express.json());

app.use((req, res, next) => {
  const logRequest = {
    method: req.method,
    url: req.url,
    headers: req.headers as IncomingHttpHeaders,
    body: req.body,
    query: req.query,
    params: req.params,
  };
  logger.debug(`Incoming request: ${JSON.stringify(logRequest, null, 2)}`);
  next();
});

app.use('/api', apiRouter);

app.all('/lb/:chain/*?', async (req: Request, res: Response) => {
  const { chain } = req.params;
  const endpoint = req.params[0] || '';

  logger.debug(`Received ${req.method} request for chain: ${chain}, endpoint: ${endpoint}`);
  logger.debug(`Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
  logger.debug(`Headers: ${JSON.stringify(req.headers)}`);
  logger.debug(`Body: ${JSON.stringify(req.body)}`);

  const startTime = Date.now();

  try {
    if (!chainsData[chain]) {
      logger.info(`Chain data for ${chain} not found, please update chain data first.`);
      return res.status(404).send(`Chain ${chain} not found. Please update chain data first.`);
    }

    await proxyRequest(chain, endpoint, req, res);
  } catch (error) {
    logger.error(`Error proxying request for ${chain}/${endpoint}:`, error);
    res.status(500).send(`Error proxying request: ${(error as Error).message}`);
  } finally {
    const endTime = Date.now();
    logger.debug(`Request for ${chain}/${endpoint} took ${endTime - startTime}ms`);
  }
});

app.options('/lb/:chain/*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.use('*', (req, res) => {
  logger.warn(`Unhandled request: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Not Found', message: 'The requested resource does not exist' });
});

app.listen(PORT, () => {
  logger.info(`Load balancer running at http://localhost:${PORT}`);
});

export { refreshChainsData };