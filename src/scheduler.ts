import { crawlAllChains } from './crawler.ts';
import dataService from './dataService.ts';
import { appLogger as logger } from './logger.ts';
// Scheduler using Bun-native timers
import type { ScheduledTask } from './types.ts';

interface HealthStatus {
	isHealthy: boolean;
	setHealthy: (healthy: boolean) => void;
}

class SchedulerService {
	private tasks = new Map<string, ScheduledTask>();
	private timers = new Map<string, ReturnType<typeof setInterval>>();
	private healthStatus: HealthStatus;

	constructor(healthStatus: HealthStatus) {
		this.healthStatus = healthStatus;
	}

	registerTask(task: ScheduledTask): void {
		this.tasks.set(task.name, task);

		if (task.enabled) {
			this.scheduleTask(task);
		}

		logger.info(`Registered task: ${task.name} (${task.schedule})`);
	}

	private parseSchedule(schedule: string): number {
		// Parse cron-like schedule to interval in ms
		// Simplified: only supports common patterns
		const parts = schedule.split(' ');

		// Every N minutes: */N * * * *
		if (parts[0].startsWith('*/')) {
			const mins = Number.parseInt(parts[0].slice(2), 10);
			return mins * 60 * 1000;
		}

		// Every hour at minute 0: 0 * * * *
		if (parts[0] === '0' && parts[1] === '*') {
			return 60 * 60 * 1000;
		}

		// Every N hours: 0 */N * * *
		if (parts[0] === '0' && parts[1].startsWith('*/')) {
			const hours = Number.parseInt(parts[1].slice(2), 10);
			return hours * 60 * 60 * 1000;
		}

		// Daily at midnight: 0 0 * * *
		if (parts[0] === '0' && parts[1] === '0') {
			return 24 * 60 * 60 * 1000;
		}

		// Default: every hour
		return 60 * 60 * 1000;
	}

	private scheduleTask(task: ScheduledTask): void {
		const interval = this.parseSchedule(task.schedule);

		const timer = setInterval(async () => {
			logger.info(`Running task: ${task.name}`);
			const start = performance.now();

			try {
				await task.handler();
				task.lastRun = new Date();
				task.nextRun = new Date(Date.now() + interval);
				logger.info(`Completed task: ${task.name} in ${(performance.now() - start).toFixed(0)}ms`);
			} catch (err) {
				logger.error(`Error in task ${task.name}`, err);

				if (task.name === 'chainDataRefresh') {
					this.healthStatus.setHealthy(false);
				}
			}
		}, interval);

		this.timers.set(task.name, timer);
		task.nextRun = new Date(Date.now() + interval);
	}

	start(): void {
		logger.info('Starting scheduler...');
		this.registerDefaultTasks();
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

	setTaskEnabled(taskName: string, enabled: boolean): boolean {
		const task = this.tasks.get(taskName);
		if (!task) {
			logger.warn(`Task not found: ${taskName}`);
			return false;
		}

		task.enabled = enabled;

		if (enabled && !this.timers.has(taskName)) {
			this.scheduleTask(task);
		} else if (!enabled && this.timers.has(taskName)) {
			const timer = this.timers.get(taskName);
			if (timer) clearInterval(timer);
			this.timers.delete(taskName);
		}

		logger.info(`Task ${taskName} ${enabled ? 'enabled' : 'disabled'}`);
		return true;
	}

	getStatus(): Array<{
		name: string;
		enabled: boolean;
		schedule: string;
		lastRun?: string;
		nextRun?: string;
		description?: string;
	}> {
		return Array.from(this.tasks.values()).map((task) => ({
			name: task.name,
			enabled: task.enabled,
			schedule: task.schedule,
			lastRun: task.lastRun?.toISOString(),
			nextRun: task.nextRun?.toISOString(),
			description: task.description,
		}));
	}

	async triggerTask(taskName: string): Promise<boolean> {
		const task = this.tasks.get(taskName);
		if (!task) {
			logger.warn(`Task not found: ${taskName}`);
			return false;
		}

		logger.info(`Manually triggering: ${taskName}`);
		try {
			await task.handler();
			task.lastRun = new Date();
			return true;
		} catch (err) {
			logger.error(`Error triggering ${taskName}`, err);
			return false;
		}
	}

	private registerDefaultTasks(): void {
		// Chain data refresh - every 12 hours
		this.registerTask({
			name: 'chainDataRefresh',
			schedule: '0 */12 * * *',
			description: 'Refresh chain data from GitHub',
			enabled: true,
			handler: async () => {
				await dataService.fetchChainsFromGitHub();
			},
		});

		// Blacklist cleanup - every hour
		this.registerTask({
			name: 'blacklistCleanup',
			schedule: '0 * * * *',
			description: 'Clean up old blacklisted IPs',
			enabled: true,
			handler: async () => {
				const result = await dataService.cleanupBlacklist();
				logger.info(`Blacklist cleanup: ${result.cleaned} removed, ${result.remaining} remaining`);
			},
		});

		// Network crawl - every 24 hours
		this.registerTask({
			name: 'networkCrawl',
			schedule: '0 0 * * *',
			description: 'Crawl network for new endpoints',
			enabled: true,
			handler: async () => {
				const results = await crawlAllChains();
				const totalNew = Object.values(results).reduce((sum, r) => sum + r.newEndpoints, 0);
				logger.info(`Crawl discovered ${totalNew} new endpoints`);
			},
		});

		// Health recovery - every 5 minutes
		this.registerTask({
			name: 'healthRecovery',
			schedule: '*/5 * * * *',
			description: 'Attempt recovery when unhealthy',
			enabled: true,
			handler: async () => {
				if (!this.healthStatus.isHealthy) {
					logger.info('Attempting recovery...');
					try {
						await dataService.fetchChainsFromGitHub();
						this.healthStatus.setHealthy(true);
						logger.info('Recovery successful');
					} catch (err) {
						logger.error('Recovery failed', err);
					}
				}
			},
		});
	}
}

export default SchedulerService;
