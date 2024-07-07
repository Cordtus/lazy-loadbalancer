import express, { Request, Response } from 'express';
import { loadChainsData } from './utils.js';
import { balancerLogger as logger } from './logger.js';
import config from './config.js';
import { ChainEntry } from './types.js';
import https from 'https';
import http from 'http';
import fetch, { RequestInit } from 'node-fetch';
import apiRouter from './api.js';

const app = express();
const PORT = config.port;

const chainsData: Record<string, ChainEntry> = loadChainsData();
const rpcIndexMap: Record<string, number> = {};
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const httpAgent = new http.Agent();

function selectNextRPC(chain: string): string {
  const rpcAddresses = chainsData[chain]?.['rpc-addresses'];
  if (!rpcAddresses || rpcAddresses.length === 0) {
    throw new Error('No RPC addresses available for the specified chain.');
  }

  if (!(chain in rpcIndexMap)) {
    rpcIndexMap[chain] = 0;
  }

  const index = rpcIndexMap[chain];
  rpcIndexMap[chain] = (index + 1) % rpcAddresses.length;

  return rpcAddresses[index];
}

import { CircuitBreaker } from './circuitBreaker';

const circuitBreakers: Record<string, CircuitBreaker> = {};

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

      logger.debug(`Response received in ${endTime - startTime}ms with status ${response.status}`);

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

app.use(express.json());

app.use((req, res, next) => {
  logger.debug(`Incoming request: ${req.method} ${req.url}`);
  logger.debug(`Headers: ${JSON.stringify(req.headers)}`);
  logger.debug(`Body: ${JSON.stringify(req.body)}`);
  next();
});

app.use('/api', apiRouter);

app.all('/lb/:chain', async (req: Request, res: Response) => {
  const { chain } = req.params;

  logger.debug(`Received ${req.method} request for chain: ${chain}`);

  try {
    if (!chainsData[chain]) {
      logger.info(`Chain data for ${chain} not found.`);
      return res.status(404).send(`Chain ${chain} not found.`);
    }

    await proxyRequest(chain, req, res);
  } catch (error) {
    logger.error(`Error proxying request for ${chain}:`, error);
    res.status(500).send(`Error proxying request: ${(error as Error).message}`);
  }
});

app.listen(PORT, () => {
  logger.info(`Load balancer running at http://localhost:${PORT}`);
});