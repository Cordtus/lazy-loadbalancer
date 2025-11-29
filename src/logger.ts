// Lightweight logger using Bun's native file APIs
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const COLORS = {
	debug: '\x1b[36m', // cyan
	info: '\x1b[32m', // green
	warn: '\x1b[33m', // yellow
	error: '\x1b[31m', // red
	reset: '\x1b[0m',
};

const logDir = join(process.cwd(), 'logs');
if (!existsSync(logDir)) {
	mkdirSync(logDir, { recursive: true });
}

class Logger {
	private name: string;
	private minLevel: number;
	private fileHandle: Bun.FileSink | null = null;
	private currentLogDate = '';

	constructor(name: string, level: LogLevel = 'info') {
		this.name = name;
		this.minLevel = LOG_LEVELS[level];
	}

	private getLogFile(): Bun.FileSink {
		const today = new Date().toISOString().split('T')[0];
		if (this.currentLogDate !== today || !this.fileHandle) {
			this.fileHandle?.end();
			const logPath = join(logDir, `${this.name}-${today}.log`);
			this.fileHandle = Bun.file(logPath).writer();
			this.currentLogDate = today;
		}
		return this.fileHandle;
	}

	private format(level: LogLevel, message: string, meta?: unknown): string {
		const ts = new Date().toISOString();
		const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
		return `${ts} [${level.toUpperCase()}] [${this.name}] ${message}${metaStr}`;
	}

	private log(level: LogLevel, message: string, meta?: unknown): void {
		if (LOG_LEVELS[level] < this.minLevel) return;

		const formatted = this.format(level, message, meta);
		const coloredLevel = `${COLORS[level]}[${level.toUpperCase()}]${COLORS.reset}`;
		const consoleMsg = `${new Date().toISOString()} ${coloredLevel} [${this.name}] ${message}`;

		// Console output
		if (level === 'error') {
			console.error(consoleMsg, meta ?? '');
		} else if (level === 'warn') {
			console.warn(consoleMsg, meta ?? '');
		} else {
			console.log(consoleMsg, meta ?? '');
		}

		// File output
		try {
			const writer = this.getLogFile();
			writer.write(`${formatted}\n`);
			writer.flush();
		} catch {
			// Ignore file write errors
		}
	}

	debug(message: string, meta?: unknown): void {
		this.log('debug', message, meta);
	}

	info(message: string, meta?: unknown): void {
		this.log('info', message, meta);
	}

	warn(message: string, meta?: unknown): void {
		this.log('warn', message, meta);
	}

	error(message: string, meta?: unknown): void {
		this.log('error', message, meta);
	}

	setLevel(level: LogLevel): void {
		this.minLevel = LOG_LEVELS[level];
	}

	close(): void {
		this.fileHandle?.end();
		this.fileHandle = null;
	}
}

// Create loggers with env-configurable levels
const getLogLevel = (name: string): LogLevel => {
	const envKey = `LOG_LEVEL_${name.toUpperCase()}`;
	const level = process.env[envKey] || process.env.LOG_LEVEL || 'info';
	return level as LogLevel;
};

export const appLogger = new Logger('app', getLogLevel('app'));
export const crawlerLogger = new Logger('crawler', getLogLevel('crawler'));
export const balancerLogger = new Logger('balancer', getLogLevel('balancer'));

export { Logger };
export type { LogLevel };
