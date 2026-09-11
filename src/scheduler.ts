import { fetchChainsFromGitHub } from './chainRegistry.ts';
import { crawlAllChains } from './crawler.ts';
import { appLogger as logger } from './logger.ts';
import type { ScheduledTask } from './types.ts';
import { cleanupBlacklist } from './utils.ts';

const HOUR = 60 * 60 * 1000;

class SchedulerService {
	private tasks = new Map<string, ScheduledTask>();
	private timers = new Map<string, ReturnType<typeof setInterval>>();

	private registerTask(task: ScheduledTask): void {
		this.tasks.set(task.name, task);
		if (task.enabled) {
			this.scheduleTask(task);
		}
		logger.info(`Registered task: ${task.name} (every ${task.intervalMs}ms)`);
	}

	private scheduleTask(task: ScheduledTask): void {
		const timer = setInterval(async () => {
			logger.info(`Running task: ${task.name}`);
			const start = performance.now();
			try {
				await task.handler();
				task.lastRun = new Date();
				task.nextRun = new Date(Date.now() + task.intervalMs);
				logger.info(`Completed task: ${task.name} in ${(performance.now() - start).toFixed(0)}ms`);
			} catch (err) {
				logger.error(`Error in task ${task.name}`, err);
			}
		}, task.intervalMs);

		this.timers.set(task.name, timer);
		task.nextRun = new Date(Date.now() + task.intervalMs);
	}

	start(): void {
		logger.info('Starting scheduler...');
		this.registerTask({
			name: 'chainDataRefresh',
			intervalMs: 12 * HOUR,
			description: 'Refresh chain data from GitHub',
			enabled: true,
			handler: fetchChainsFromGitHub,
		});
		this.registerTask({
			name: 'blacklistCleanup',
			intervalMs: HOUR,
			description: 'Clean up old blacklisted IPs',
			enabled: true,
			handler: async () => {
				const result = await cleanupBlacklist();
				logger.info(`Blacklist cleanup: ${result.cleaned} removed, ${result.remaining} remaining`);
			},
		});
		this.registerTask({
			name: 'networkCrawl',
			intervalMs: 24 * HOUR,
			description: 'Crawl network for new endpoints',
			enabled: true,
			handler: async () => {
				const results = await crawlAllChains();
				const totalNew = Object.values(results).reduce((sum, r) => sum + r.newEndpoints, 0);
				logger.info(`Crawl discovered ${totalNew} new endpoints`);
			},
		});
		logger.info(`Scheduler started with ${this.tasks.size} tasks`);
	}

	stop(): void {
		logger.info('Stopping scheduler...');
		for (const [name, timer] of this.timers) {
			clearInterval(timer);
			logger.debug(`Cancelled task: ${name}`);
		}
		this.timers.clear();
		logger.info('Scheduler stopped');
	}

	getStatus(): Array<{
		name: string;
		enabled: boolean;
		intervalMs: number;
		lastRun?: string;
		nextRun?: string;
		description?: string;
	}> {
		return Array.from(this.tasks.values()).map((task) => ({
			name: task.name,
			enabled: task.enabled,
			intervalMs: task.intervalMs,
			lastRun: task.lastRun?.toISOString(),
			nextRun: task.nextRun?.toISOString(),
			description: task.description,
		}));
	}
}

export default SchedulerService;
