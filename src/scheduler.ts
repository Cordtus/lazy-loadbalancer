// scheduler.ts - Centralized scheduling service
import { scheduleJob, Job } from 'node-schedule';
import { appLogger as logger } from './logger.js';
import dataService from './dataService.js';
import { crawlAllChains } from './crawler.js';
import { performance } from 'perf_hooks';

export interface ScheduledTask {
  name: string;
  schedule: string;
  handler: () => Promise<void> | void;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  description?: string;
}

class SchedulerService {
  private jobs: Map<string, Job> = new Map();
  private tasks: Map<string, ScheduledTask> = new Map();
  private healthStatus: { isHealthy: boolean; setHealthy: (healthy: boolean) => void };

  constructor(healthStatus: { isHealthy: boolean; setHealthy: (healthy: boolean) => void }) {
    this.healthStatus = healthStatus;
  }

  // Register a scheduled task
  registerTask(task: ScheduledTask): void {
    this.tasks.set(task.name, task);
    
    if (task.enabled) {
      this.scheduleTask(task);
    }
    
    logger.info(`Registered scheduled task: ${task.name} (${task.schedule})`);
  }

  // Schedule a task using node-schedule
  private scheduleTask(task: ScheduledTask): void {
    const job = scheduleJob(task.schedule, async () => {
      logger.info(`Running scheduled task: ${task.name}`);
      const startTime = performance.now();
      
      try {
        await task.handler();
        task.lastRun = new Date();
        const duration = performance.now() - startTime;
        logger.info(`Completed scheduled task: ${task.name} in ${duration.toFixed(2)}ms`);
      } catch (error) {
        logger.error(`Error in scheduled task ${task.name}:`, error);
        
        // Handle health impacts for critical tasks
        if (task.name === 'chainDataRefresh') {
          this.healthStatus.setHealthy(false);
        }
      }
    });

    if (job) {
      this.jobs.set(task.name, job);
      task.nextRun = job.nextInvocation();
    } else {
      logger.error(`Failed to schedule task: ${task.name}`);
    }
  }

  // Start all registered tasks
  start(): void {
    logger.info('Starting scheduler service...');
    
    // Define default tasks
    this.registerDefaultTasks();
    
    logger.info(`Scheduler started with ${this.tasks.size} tasks`);
  }

  // Stop all scheduled tasks
  stop(): void {
    logger.info('Stopping scheduler service...');
    
    for (const [name, job] of this.jobs) {
      job.cancel();
      logger.debug(`Cancelled scheduled task: ${name}`);
    }
    
    this.jobs.clear();
    logger.info('Scheduler service stopped');
  }

  // Enable/disable a specific task
  setTaskEnabled(taskName: string, enabled: boolean): boolean {
    const task = this.tasks.get(taskName);
    if (!task) {
      logger.warn(`Task not found: ${taskName}`);
      return false;
    }

    task.enabled = enabled;
    
    if (enabled && !this.jobs.has(taskName)) {
      this.scheduleTask(task);
    } else if (!enabled && this.jobs.has(taskName)) {
      const job = this.jobs.get(taskName);
      job?.cancel();
      this.jobs.delete(taskName);
    }
    
    logger.info(`Task ${taskName} ${enabled ? 'enabled' : 'disabled'}`);
    return true;
  }

  // Get status of all tasks
  getStatus(): Array<{
    name: string;
    enabled: boolean;
    schedule: string;
    lastRun?: string;
    nextRun?: string;
    description?: string;
  }> {
    return Array.from(this.tasks.values()).map(task => ({
      name: task.name,
      enabled: task.enabled,
      schedule: task.schedule,
      lastRun: task.lastRun?.toISOString(),
      nextRun: task.nextRun?.toISOString(),
      description: task.description,
    }));
  }

  // Manually trigger a task
  async triggerTask(taskName: string): Promise<boolean> {
    const task = this.tasks.get(taskName);
    if (!task) {
      logger.warn(`Task not found for manual trigger: ${taskName}`);
      return false;
    }

    logger.info(`Manually triggering task: ${taskName}`);
    try {
      await task.handler();
      task.lastRun = new Date();
      return true;
    } catch (error) {
      logger.error(`Error manually triggering task ${taskName}:`, error);
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
        const totalNewEndpoints = Object.values(results).reduce(
          (sum, result) => sum + result.newEndpoints,
          0
        );
        logger.info(`Network crawl discovered ${totalNewEndpoints} new endpoints`);
      },
    });

    // Health recovery - every 5 minutes
    this.registerTask({
      name: 'healthRecovery',
      schedule: '*/5 * * * *',
      description: 'Attempt system recovery when unhealthy',
      enabled: true,
      handler: async () => {
        if (!this.healthStatus.isHealthy) {
          logger.info('System unhealthy, attempting recovery...');
          try {
            // Try to refresh chain data
            await dataService.fetchChainsFromGitHub();
            this.healthStatus.setHealthy(true);
            logger.info('System recovery successful');
          } catch (error) {
            logger.error('Recovery attempt failed:', error);
          }
        }
      },
    });
  }
}

export default SchedulerService;