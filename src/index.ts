// Entry point for Cosmos SDK Load Balancer (Bun)
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import {
	getChainStats,
	getChainsData,
	getStats,
	initChainsData,
	proxyWithCaching,
} from './balancer.ts';
import { flushCache, getCacheStats } from './cacheManager.ts';
import config from './config.ts';
import { crawlAllChains, crawlNetwork } from './crawler.ts';
import dataService from './dataService.ts';
import { appLogger as logger } from './logger.ts';
import SchedulerService from './scheduler.ts';
import type { ChainConfig, GlobalConfig } from './types.ts';

// App state
let isInitialFetchComplete = false;
let isHealthy = true;

const scheduler = new SchedulerService({
	isHealthy,
	setHealthy: (healthy: boolean) => {
		isHealthy = healthy;
	},
});

// Create Hono app
const app = new Hono();

// Middleware
app.use('*', cors());
app.use('*', compress());
app.use('*', secureHeaders());

// Request logging middleware
app.use('*', async (c, next) => {
	const start = performance.now();
	await next();
	const duration = performance.now() - start;
	logger.debug(`${c.req.method} ${c.req.path} ${c.res.status} ${duration.toFixed(0)}ms`);
});

// Root endpoint
app.get('/', (c) => {
	return c.json({
		name: 'Cosmos SDK Load Balancer',
		version: '3.0.0',
		runtime: 'Bun',
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

// Health check
app.get('/health', (c) => {
	const globalConfig = config.service.getGlobalConfig();

	return c.json(
		{
			status: isHealthy ? 'UP' : 'DEGRADED',
			timestamp: new Date().toISOString(),
			initialFetchComplete: isInitialFetchComplete,
			chains: Object.keys(globalConfig.chains || {}).length,
			cacheStats: getCacheStats(),
			schedulerTasks: scheduler.getStatus(),
			memory: process.memoryUsage(),
		},
		isHealthy ? 200 : 503
	);
});

// Stats endpoint
app.get('/stats', (c) => {
	return c.json(getStats());
});

app.get('/stats/:chain', (c) => {
	const chain = c.req.param('chain');
	const stats = getChainStats(chain);
	if (!stats) {
		return c.json({ error: `No stats for chain ${chain}` }, 404);
	}
	return c.json(stats);
});

// API routes
const api = new Hono();

api.get('/chain-list', async (c) => {
	const chainsData = await dataService.loadChainsData();
	return c.json(Object.keys(chainsData));
});

api.get('/chains-summary', async (c) => {
	const chainsData = await dataService.loadChainsData();
	const summary = Object.entries(chainsData).map(([name, data]) => ({
		name,
		endpointCount: data.rpcAddresses.length,
	}));
	return c.json(summary);
});

api.get('/rpc-list/:chainName', async (c) => {
	const chainName = c.req.param('chainName');
	const chainData = await dataService.getChain(chainName);
	if (!chainData) {
		return c.json({ error: `Chain ${chainName} not found` }, 404);
	}
	return c.json({
		chainName,
		rpcCount: chainData.rpcAddresses.length,
		rpcList: chainData.rpcAddresses,
	});
});

api.post('/update-chain/:chainName', async (c) => {
	const chainName = c.req.param('chainName');
	const chainData = await dataService.getChain(chainName);
	if (!chainData) {
		return c.json({ error: `Chain ${chainName} not found` }, 404);
	}

	try {
		logger.info(`Updating chain: ${chainName}`);
		const result = await crawlNetwork(chainName, chainData.rpcAddresses);
		return c.json(result);
	} catch (err) {
		logger.error(`Error updating ${chainName}`, err);
		return c.json({ error: `Failed to update chain ${chainName}` }, 500);
	}
});

api.post('/update-all-chains', async (c) => {
	try {
		logger.info('Updating all chains');
		const results = await crawlAllChains();
		return c.json(results);
	} catch (err) {
		logger.error('Error updating all chains', err);
		return c.json({ error: 'Failed to update all chains' }, 500);
	}
});

api.post('/cleanup-blacklist', async (c) => {
	try {
		logger.info('Cleaning up blacklist');
		const result = await dataService.cleanupBlacklist();
		return c.json({ message: 'Blacklist cleanup completed', result });
	} catch (err) {
		logger.error('Error cleaning up blacklist', err);
		return c.json({ error: 'Failed to cleanup blacklist' }, 500);
	}
});

api.post('/add-chain', async (c) => {
	const body = await c.req.json();
	const { chainName, chainId, rpcAddresses, bech32Prefix } = body;

	if (!chainName || !chainId || !rpcAddresses || !Array.isArray(rpcAddresses) || !bech32Prefix) {
		return c.json(
			{
				error:
					'Invalid chain data. Required: chainName, chainId, rpcAddresses (array), bech32Prefix',
			},
			400
		);
	}

	const existing = await dataService.getChain(chainName);
	if (existing) {
		return c.json({ error: `Chain ${chainName} already exists` }, 409);
	}

	const chainsData = await dataService.loadChainsData();
	chainsData[chainName] = {
		chainName,
		chainId,
		rpcAddresses,
		bech32Prefix,
		timeout: '30s',
	};

	await dataService.saveChainsData(chainsData);
	logger.info(`Added chain: ${chainName}`);
	return c.json({ message: `Chain ${chainName} added successfully` }, 201);
});

api.delete('/remove-chain/:chainName', async (c) => {
	const chainName = c.req.param('chainName');
	const chainsData = await dataService.loadChainsData();

	if (!chainsData[chainName]) {
		return c.json({ error: `Chain ${chainName} not found` }, 404);
	}

	delete chainsData[chainName];
	await dataService.saveChainsData(chainsData);
	logger.info(`Removed chain: ${chainName}`);
	return c.json({ message: `Chain ${chainName} removed successfully` });
});

app.route('/api', api);

// Config routes
const configRoutes = new Hono();

configRoutes.get('/global', (c) => {
	return c.json(config.service.getGlobalConfig());
});

configRoutes.put('/global', async (c) => {
	try {
		const body = await c.req.json<GlobalConfig>();
		config.service.saveGlobalConfig(body);
		return c.json({ success: true, message: 'Global config updated' });
	} catch (err) {
		logger.error('Error updating global config', err);
		return c.json({ success: false, message: 'Failed to update global config' }, 500);
	}
});

configRoutes.get('/chain/:chainName', (c) => {
	const chainName = c.req.param('chainName');
	const chainConfig = config.service.getChainConfig(chainName);
	if (!chainConfig) {
		return c.json({ error: `No config for chain ${chainName}` }, 404);
	}
	return c.json(chainConfig);
});

configRoutes.put('/chain/:chainName', async (c) => {
	const chainName = c.req.param('chainName');
	try {
		const body = await c.req.json<ChainConfig>();
		config.service.saveChainConfig(chainName, body);
		return c.json({ success: true, message: `Config for ${chainName} updated` });
	} catch (err) {
		logger.error(`Error updating config for ${chainName}`, err);
		return c.json({ success: false, message: `Failed to update config for ${chainName}` }, 500);
	}
});

app.route('/config', configRoutes);

// Cache routes
app.delete('/cache/:chain/:path?', (c) => {
	const chain = c.req.param('chain');
	const path = c.req.param('path');
	const pattern = path ? `${chain}:.*${path}` : `${chain}:`;
	const deletedCount = flushCache(pattern);
	return c.json({ success: true, deletedCount });
});

// Load balancer routes
app.all('/lb/:chain/*', async (c) => {
	const chain = c.req.param('chain');
	const chainsData = getChainsData();

	if (!chainsData[chain]) {
		logger.info(`Chain ${chain} not found`);
		return c.text(`Chain ${chain} not found`, 404);
	}

	const path = c.req.path.replace(`/lb/${chain}`, '').replace(/^\//, '');
	const clientIp =
		c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || '0.0.0.0';

	try {
		const body = ['POST', 'PUT', 'PATCH'].includes(c.req.method) ? await c.req.text() : null;

		const response = await proxyWithCaching(
			chain,
			path,
			c.req.method,
			new Headers(c.req.raw.headers),
			body,
			clientIp
		);

		return response;
	} catch (err) {
		logger.error(`Error proxying request for ${chain}`, err);
		return c.text(
			`Unable to process request: ${err instanceof Error ? err.message : 'Unknown error'}`,
			502
		);
	}
});

// Error handler
app.onError((err, c) => {
	logger.error('Unhandled error', err);
	return c.json(
		{
			error: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
		},
		500
	);
});

// 404 handler
app.notFound((c) => {
	return c.json({ error: 'Not found' }, 404);
});

// Main startup
async function main() {
	logger.info('Starting application...');
	const startTime = performance.now();

	try {
		logger.info('Fetching initial chain data...');
		try {
			await dataService.fetchChainsFromGitHub();
			isInitialFetchComplete = true;
			logger.info('Initial chain fetch completed');
		} catch (err) {
			logger.error('Error during initial fetch', err);
			logger.warn('Continuing with stale data');
		}

		// Initialize balancer with chain data
		await initChainsData();

		// Start scheduler
		scheduler.start();

		// Start server
		const port = config.port;

		const server = Bun.serve({
			port,
			fetch: app.fetch,
			// Increase idle timeout to allow long-running crawl requests to complete
			// Bun expects a small integer (max 255). Use 255 seconds (~4.25 minutes).
			idleTimeout: 255,
		});

		const duration = performance.now() - startTime;
		logger.info(`Server started at http://localhost:${port} in ${duration.toFixed(0)}ms`);

		// Graceful shutdown
		process.on('SIGINT', () => {
			logger.info('Shutting down...');
			scheduler.stop();
			server.stop();
			process.exit(0);
		});

		process.on('SIGTERM', () => {
			logger.info('Shutting down...');
			scheduler.stop();
			server.stop();
			process.exit(0);
		});
	} catch (err) {
		logger.error('Fatal error during startup', err);
		isHealthy = false;
		process.exit(1);
	}
}

main().catch((err) => {
	logger.error('Unhandled error in main', err);
	process.exit(1);
});
