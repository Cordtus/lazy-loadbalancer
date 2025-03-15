// Enhanced circuitBreaker.ts
export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export interface CircuitBreakerOptions {
  failureThreshold: number;       // Number of failures before opening circuit
  resetTimeout: number;           // Time in ms before trying to half-open
  halfOpenTimeout: number;        // Time in ms before resetting in half-open state
  rollingWindowSize: number;      // Size of the rolling window in ms
  minimumRequestThreshold: number; // Minimum requests before calculating error rate
  errorThresholdPercentage: number; // Percentage of errors to trigger opening
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private successesInHalfOpen: number = 0;
  private requests: number = 0;
  private failureHistory: Array<{ timestamp: number, failed: boolean }> = [];
  private options: CircuitBreakerOptions;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    // Default settings
    this.options = {
      failureThreshold: 5,
      resetTimeout: 30000,        // 30 seconds
      halfOpenTimeout: 5000,      // 5 seconds
      rollingWindowSize: 60000,   // 1 minute rolling window
      minimumRequestThreshold: 10, // At least 10 requests before calculating error rate
      errorThresholdPercentage: 50, // 50% error rate triggers opening
      ...options
    };
  }

  isOpen(): boolean {
    this.cleanupFailureHistory();
    
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (now - this.lastFailureTime > this.options.resetTimeout) {
        this.transitionToHalfOpen();
      }
    }
    
    return this.state === CircuitState.OPEN;
  }

  recordSuccess(): void {
    this.requests++;
    
    // Track this success in our rolling window
    this.failureHistory.push({ timestamp: Date.now(), failed: false });
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successesInHalfOpen++;
      // After a certain number of successes in half-open state, close the circuit
      if (this.successesInHalfOpen >= 3) {
        this.reset();
      }
    }
  }

  recordFailure(): void {
    this.requests++;
    this.failures++;
    this.lastFailureTime = Date.now();
    
    // Track this failure in our rolling window
    this.failureHistory.push({ timestamp: Date.now(), failed: true });
    
    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open immediately opens the circuit again
      this.state = CircuitState.OPEN;
      this.successesInHalfOpen = 0;
    } else if (this.state === CircuitState.CLOSED) {
      // Check if we should open the circuit
      if (this.failures >= this.options.failureThreshold || this.calculateErrorRate() >= this.options.errorThresholdPercentage) {
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
    this.cleanupFailureHistory();
    
    return {
      state: this.state,
      failures: this.failures,
      successRate: this.requests > 0 ? (1 - (this.failures / this.requests)) * 100 : 100,
      requestCount: this.requests,
      lastFailureTime: this.lastFailureTime
    };
  }

  private calculateErrorRate(): number {
    this.cleanupFailureHistory();
    
    if (this.failureHistory.length < this.options.minimumRequestThreshold) {
      return 0; // Not enough requests to calculate error rate
    }
    
    const failedCount = this.failureHistory.filter(item => item.failed).length;
    return (failedCount / this.failureHistory.length) * 100;
  }

  private cleanupFailureHistory(): void {
    const now = Date.now();
    const cutoff = now - this.options.rollingWindowSize;
    
    // Remove old entries from the rolling window
    this.failureHistory = this.failureHistory.filter(item => item.timestamp >= cutoff);
    
    // Recalculate failure count based on the current window
    this.failures = this.failureHistory.filter(item => item.failed).length;
    this.requests = this.failureHistory.length;
  }

  private transitionToHalfOpen(): void {
    this.state = CircuitState.HALF_OPEN;
    this.successesInHalfOpen = 0;
    
    // Auto-reset to OPEN if no successful requests come in during half-open period
    setTimeout(() => {
      if (this.state === CircuitState.HALF_OPEN && this.successesInHalfOpen === 0) {
        this.state = CircuitState.OPEN;
        this.lastFailureTime = Date.now(); // Reset the timer to prevent immediate half-open transition
      }
    }, this.options.halfOpenTimeout);
  }

  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.lastFailureTime = 0;
    this.successesInHalfOpen = 0;
    this.failureHistory = [];
  }
}