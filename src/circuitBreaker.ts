// Circuit breaker pattern for fault tolerance
import { CircuitState } from './types.ts';

export interface CircuitBreakerOptions {
	failureThreshold: number;
	resetTimeout: number;
	halfOpenTimeout: number;
	rollingWindowSize: number;
	minRequestThreshold: number;
	errorThresholdPct: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
	failureThreshold: 5,
	resetTimeout: 30000,
	halfOpenTimeout: 5000,
	rollingWindowSize: 60000,
	minRequestThreshold: 10,
	errorThresholdPct: 50,
};

export class CircuitBreaker {
	private state: CircuitState = CircuitState.CLOSED;
	private failures = 0;
	private lastFailureTime = 0;
	private halfOpenSuccesses = 0;
	private history: Array<{ ts: number; failed: boolean }> = [];
	private options: CircuitBreakerOptions;
	private halfOpenTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options?: Partial<CircuitBreakerOptions>) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	isOpen(): boolean {
		this.cleanup();

		if (this.state === CircuitState.OPEN) {
			if (Date.now() - this.lastFailureTime > this.options.resetTimeout) {
				this.transitionToHalfOpen();
			}
		}

		return this.state === CircuitState.OPEN;
	}

	recordSuccess(): void {
		this.history.push({ ts: Date.now(), failed: false });

		if (this.state === CircuitState.HALF_OPEN) {
			this.halfOpenSuccesses++;
			if (this.halfOpenSuccesses >= 3) {
				this.reset();
			}
		}
	}

	recordFailure(): void {
		this.failures++;
		this.lastFailureTime = Date.now();
		this.history.push({ ts: Date.now(), failed: true });

		if (this.state === CircuitState.HALF_OPEN) {
			this.state = CircuitState.OPEN;
			this.halfOpenSuccesses = 0;
		} else if (this.state === CircuitState.CLOSED) {
			if (
				this.failures >= this.options.failureThreshold ||
				this.errorRate() >= this.options.errorThresholdPct
			) {
				this.state = CircuitState.OPEN;
			}
		}
	}

	getState(): CircuitState {
		return this.state;
	}

	getStats(): {
		state: CircuitState;
		failures: number;
		successRate: number;
		requestCount: number;
		lastFailureTime: number;
	} {
		this.cleanup();
		const total = this.history.length;
		return {
			state: this.state,
			failures: this.failures,
			successRate: total > 0 ? (1 - this.failures / total) * 100 : 100,
			requestCount: total,
			lastFailureTime: this.lastFailureTime,
		};
	}

	private errorRate(): number {
		this.cleanup();
		if (this.history.length < this.options.minRequestThreshold) return 0;
		const failed = this.history.filter((h) => h.failed).length;
		return (failed / this.history.length) * 100;
	}

	private cleanup(): void {
		const cutoff = Date.now() - this.options.rollingWindowSize;
		this.history = this.history.filter((h) => h.ts >= cutoff);
		this.failures = this.history.filter((h) => h.failed).length;
	}

	private transitionToHalfOpen(): void {
		this.state = CircuitState.HALF_OPEN;
		this.halfOpenSuccesses = 0;

		if (this.halfOpenTimer) clearTimeout(this.halfOpenTimer);
		this.halfOpenTimer = setTimeout(() => {
			if (this.state === CircuitState.HALF_OPEN && this.halfOpenSuccesses === 0) {
				this.state = CircuitState.OPEN;
				this.lastFailureTime = Date.now();
			}
		}, this.options.halfOpenTimeout);
	}

	private reset(): void {
		this.state = CircuitState.CLOSED;
		this.failures = 0;
		this.lastFailureTime = 0;
		this.halfOpenSuccesses = 0;
		this.history = [];
		if (this.halfOpenTimer) {
			clearTimeout(this.halfOpenTimer);
			this.halfOpenTimer = null;
		}
	}
}

export { CircuitState };
