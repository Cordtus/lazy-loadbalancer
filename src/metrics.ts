// metrics.ts - Stub implementation for metrics history

export interface MetricData {
  endTime: number;
  [key: string]: any;
}

class MetricsHistory {
  private data = new Map<string, MetricData>();

  getChainHistory(chainId: string) {
    return {
      chainId,
      metrics: [],
      count: 0
    };
  }

  getLatestMetrics(): Map<string, MetricData> {
    return this.data;
  }

  addMetric(chainId: string, metric: MetricData) {
    this.data.set(chainId, metric);
  }
}

export const metricsHistory = new MetricsHistory();