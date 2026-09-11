// Circuit breaker: skip an endpoint after repeated failures, retry after a cooldown.
const FAILURE_THRESHOLD = 5;
const RESET_TIMEOUT_MS = 30000;

export class CircuitBreaker {
	private failures = 0;
	private openedAt = 0;

	isOpen(): boolean {
		if (this.openedAt === 0) return false;
		if (Date.now() - this.openedAt > RESET_TIMEOUT_MS) {
			this.reset();
			return false;
		}
		return true;
	}

	recordSuccess(): void {
		this.reset();
	}

	recordFailure(): void {
		this.failures++;
		if (this.failures >= FAILURE_THRESHOLD) {
			this.openedAt = Date.now();
		}
	}

	private reset(): void {
		this.failures = 0;
		this.openedAt = 0;
	}
}
