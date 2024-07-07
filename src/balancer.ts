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

function loadAndConvertBlacklistedIPs() {
  const ips = loadBlacklistedIPs();
  const now = Date.now();
  blacklistedIPs = ips.reduce((acc, ip) => {
    acc[ip] = now;
    return acc;
  }, {} as Record<string, number>);
}

loadAndConvertBlacklistedIPs();

function updateBlacklist() {
  const now = Date.now();
  for (const [ip, timestamp] of Object.entries(blacklistedIPs)) {
    if (now - timestamp > BLACKLIST_DURATION) {
      delete blacklistedIPs[ip];
    }
  }
  saveBlacklistedIPs(Object.keys(blacklistedIPs));
}

function blacklistIP(ip: string) {
  blacklistedIPs[ip] = Date.now();
  saveBlacklistedIPs(Object.keys(blacklistedIPs));
  logger.info(`IP ${ip} has been blacklisted`);
}

function refreshChainsData() {
  chainsData = loadChainsData();
  logger.info('Chains data refreshed');
}

async function proxyRequest(chain: string, endpoint: string, req: Request, res: Response): Promise<void> {
  const rpcAddresses = chainsData[chain]?.['rpc-addresses'];
  if (!rpcAddresses || rpcAddresses.length === 0) {
    res.status(500).send('No RPC addresses available for the specified chain.');
    return;
  }

  if (!(chain in rpcIndexMap)) {
    rpcIndexMap[chain] = 0;
  }

  let attempts = 0;
  const maxAttempts = rpcAddresses.length;
  let consecutiveFailures = 0;
  let lastFailedIP = '';

  while (attempts < maxAttempts) {
    const rpcAddress = rpcAddresses[rpcIndexMap[chain]];
    const url = new URL(`${rpcAddress.replace(/\/$/, '')}/${endpoint}`);
    const ip = url.hostname;
    
    logger.debug(`Proxying to URL: ${url.href}`);
    logger.debug(`Request method: ${req.method}`);
    logger.debug(`Request headers: ${JSON.stringify(req.headers)}`);
    logger.debug(`Request body: ${JSON.stringify(req.body)}`);

    if (ip in blacklistedIPs) {
      rpcIndexMap[chain] = (rpcIndexMap[chain] + 1) % rpcAddresses.length;
      attempts++;
      continue;
    }

    logger.info(`Proxying ${req.method} request to: ${url.href}`);

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

      const response = await fetch(url.href, fetchOptions);
      const responseText = await response.text();

      if (response.ok) {
        consecutiveFailures = 0;
        lastFailedIP = '';

        for (const [key, value] of response.headers.entries()) {
          if (!['content-encoding', 'content-length'].includes(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        }
        
        try {
          const jsonData = JSON.parse(responseText);
          res.status(response.status).json(jsonData);
        } catch {
          res.status(response.status).send(responseText);
        }
        return;
      } else {
        logger.error(`Non-OK response from ${url.href}: ${response.status}`);
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    } catch (error) {
      logger.error(`Error proxying request to ${url.href}:`, error);
      
      if (ip === lastFailedIP) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          blacklistIP(ip);
          consecutiveFailures = 0;
        }
      } else {
        consecutiveFailures = 1;
        lastFailedIP = ip;
      }
    }

    rpcIndexMap[chain] = (rpcIndexMap[chain] + 1) % rpcAddresses.length;
    attempts++;
  }

  res.status(502).send('Unable to process request after multiple attempts');
}

setInterval(updateBlacklist, 60 * 60 * 1000); // Check every hour

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

app.all('/lb/:chain', async (req: Request, res: Response) => {
  const { chain } = req.params;
  
  logger.debug(`Received ${req.method} request for chain: ${chain}`);
  logger.debug(`Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
  logger.debug(`Headers: ${JSON.stringify(req.headers)}`);
  logger.debug(`Body: ${JSON.stringify(req.body)}`);

  refreshChainsData();

  try {
    if (!chainsData[chain]) {
      logger.info(`Chain data for ${chain} not found, please update chain data first.`);
      return res.status(404).send(`Chain ${chain} not found. Please update chain data first.`);
    }

    await proxyRequest(chain, '', req, res);
  } catch (error) {
    logger.error(`Error proxying request for ${chain}:`, error);
    res.status(500).send(`Error proxying request: ${(error as Error).message}`);
  }
});

// Keep the existing route for requests with additional path
app.all('/lb/:chain/*', async (req: Request, res: Response) => {
  const { chain } = req.params;
  const endpoint = req.params[0] || '';

  logger.debug(`Received ${req.method} request for chain: ${chain}, endpoint: ${endpoint}`);
  logger.debug(`Full URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
  logger.debug(`Headers: ${JSON.stringify(req.headers)}`);
  logger.debug(`Body: ${JSON.stringify(req.body)}`);

  refreshChainsData();

  try {
    if (!chainsData[chain]) {
      logger.info(`Chain data for ${chain} not found, please update chain data first.`);
      return res.status(404).send(`Chain ${chain} not found. Please update chain data first.`);
    }

    await proxyRequest(chain, endpoint, req, res);
  } catch (error) {
    logger.error(`Error proxying request for ${chain}/${endpoint}:`, error);
    res.status(500).send(`Error proxying request: ${(error as Error).message}`);
  }
});

app.options('/lb/:chain/*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

// Move this to the end to catch any unhandled routes
app.use('*', (req, res) => {
  logger.warn(`Unhandled request: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Not Found', message: 'The requested resource does not exist' });
});

app.listen(PORT, () => {
  logger.info(`Load balancer running at http://localhost:${PORT}`);
});

export { refreshChainsData };