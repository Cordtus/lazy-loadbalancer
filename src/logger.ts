// Lightweight logger using Bun's native file APIs
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS: Record<LogLevel, string> = {
	debug: '\x1b[36m',
	info: '\x1b[32m',
	warn: '\x1b[33m',
	error: '\x1b[31m',
};
const RESET = '\x1b[0m';

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
			this.fileHandle = Bun.file(join(logDir, `${this.name}-${today}.log`)).writer();
			this.currentLogDate = today;
		}
		return this.fileHandle;
	}

	private log(level: LogLevel, message: string, meta?: unknown): void {
		if (LOG_LEVELS[level] < this.minLevel) return;

		const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${this.name}] ${message}`;
		console[level === 'debug' ? 'log' : level](
			`${new Date().toISOString()} ${COLORS[level]}[${level.toUpperCase()}]${RESET} [${this.name}] ${message}`,
			meta ?? ''
		);

		try {
			const writer = this.getLogFile();
			writer.write(`${line}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`);
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
}

const getLogLevel = (name: string): LogLevel => {
	const level = process.env[`LOG_LEVEL_${name.toUpperCase()}`] || process.env.LOG_LEVEL || 'info';
	return level as LogLevel;
};

export const appLogger = new Logger('app', getLogLevel('app'));
export const crawlerLogger = new Logger('crawler', getLogLevel('crawler'));
export const balancerLogger = new Logger('balancer', getLogLevel('balancer'));

export { Logger };
export type { LogLevel };
