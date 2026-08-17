import type { StrategyLog } from "../../domain/strategy";

export type WsConnectionState = "connected" | "disconnected" | "reconnecting";

/** product-requirements.md metrics-to-emit */
export type RuntimeMetrics = {
  wsConnectionState: WsConnectionState;
  lastFeedUpdateAgeMs: number | undefined;
  restLatencyMs: number | undefined;
  restWsErrorCount: number;
  orderCreateCount: number;
  orderCancelCount: number;
  rateLimit429Count: number;
  openOrderCount: number;
  positionQuantity: number;
  positionNotional: number | undefined;
  realizedPnl: number | undefined;
  unrealizedPnl: number | undefined;
  strategyState: string;
  protectiveCoverage: boolean;
  reconciliationMismatch: number;
  killSwitchCount: number;
};

export type MetricAlert = {
  level: "warn" | "error";
  event: string;
  details: Record<string, unknown>;
};

export function emptyRuntimeMetrics(strategyState = "CREATED"): RuntimeMetrics {
  return {
    wsConnectionState: "disconnected",
    lastFeedUpdateAgeMs: undefined,
    restLatencyMs: undefined,
    restWsErrorCount: 0,
    orderCreateCount: 0,
    orderCancelCount: 0,
    rateLimit429Count: 0,
    openOrderCount: 0,
    positionQuantity: 0,
    positionNotional: undefined,
    realizedPnl: undefined,
    unrealizedPnl: undefined,
    strategyState,
    protectiveCoverage: true,
    reconciliationMismatch: 0,
    killSwitchCount: 0,
  };
}

export class RuntimeMetricsCollector {
  private wsConnectionState: WsConnectionState = "disconnected";
  private lastFeedEventTime: number | undefined;
  private restLatencyMs: number | undefined;
  private restWsErrorCount = 0;
  private orderCreateCount = 0;
  private orderCancelCount = 0;
  private rateLimit429Count = 0;
  private openOrderCount = 0;
  private positionQuantity = 0;
  private positionNotional: number | undefined;
  private realizedPnl: number | undefined;
  private unrealizedPnl: number | undefined;
  private strategyState = "CREATED";
  private protectiveCoverage = true;
  private reconciliationMismatch = 0;
  private killSwitchCount = 0;

  recordWsState(state: WsConnectionState): void {
    this.wsConnectionState = state;
  }

  recordFeedEvent(eventTime: number): void {
    this.lastFeedEventTime = eventTime;
  }

  recordRestLatency(ms: number): void {
    this.restLatencyMs = ms;
  }

  recordRestWsError(): void {
    this.restWsErrorCount += 1;
  }

  recordOrderCreate(count = 1): void {
    this.orderCreateCount += count;
  }

  recordOrderCancel(count = 1): void {
    this.orderCancelCount += count;
  }

  record429(): void {
    this.rateLimit429Count += 1;
  }

  recordOpenOrderCount(count: number): void {
    this.openOrderCount = count;
  }

  recordPosition(input: {
    quantity: number;
    notional?: number;
    realizedPnl?: number;
    unrealizedPnl?: number;
  }): void {
    this.positionQuantity = input.quantity;
    this.positionNotional = input.notional;
    this.realizedPnl = input.realizedPnl;
    this.unrealizedPnl = input.unrealizedPnl;
  }

  recordStrategyState(state: string): void {
    this.strategyState = state;
  }

  recordProtectiveCoverage(covered: boolean): void {
    this.protectiveCoverage = covered;
  }

  recordReconciliationMismatch(count: number): void {
    this.reconciliationMismatch = count;
  }

  recordKillSwitch(): void {
    this.killSwitchCount += 1;
  }

  snapshot(now: number): RuntimeMetrics {
    return {
      wsConnectionState: this.wsConnectionState,
      lastFeedUpdateAgeMs:
        this.lastFeedEventTime === undefined
          ? undefined
          : now - this.lastFeedEventTime,
      restLatencyMs: this.restLatencyMs,
      restWsErrorCount: this.restWsErrorCount,
      orderCreateCount: this.orderCreateCount,
      orderCancelCount: this.orderCancelCount,
      rateLimit429Count: this.rateLimit429Count,
      openOrderCount: this.openOrderCount,
      positionQuantity: this.positionQuantity,
      positionNotional: this.positionNotional,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this.unrealizedPnl,
      strategyState: this.strategyState,
      protectiveCoverage: this.protectiveCoverage,
      reconciliationMismatch: this.reconciliationMismatch,
      killSwitchCount: this.killSwitchCount,
    };
  }
}

export function alertsFromMetrics(
  metrics: RuntimeMetrics,
  options: { feedStaleMs: number },
): MetricAlert[] {
  const alerts: MetricAlert[] = [];
  if (metrics.wsConnectionState !== "connected") {
    alerts.push({
      level: "warn",
      event: "ws_disconnected",
      details: { wsConnectionState: metrics.wsConnectionState },
    });
  }
  if (
    metrics.lastFeedUpdateAgeMs !== undefined &&
    metrics.lastFeedUpdateAgeMs >= options.feedStaleMs
  ) {
    alerts.push({
      level: "warn",
      event: "feed_stale",
      details: { lastFeedUpdateAgeMs: metrics.lastFeedUpdateAgeMs },
    });
  }
  if (metrics.restWsErrorCount > 0) {
    alerts.push({
      level: "warn",
      event: "rest_ws_error",
      details: { restWsErrorCount: metrics.restWsErrorCount },
    });
  }
  if (metrics.rateLimit429Count > 0) {
    alerts.push({
      level: "warn",
      event: "rate_limit",
      details: { rateLimit429Count: metrics.rateLimit429Count },
    });
  }
  if (metrics.reconciliationMismatch > 0) {
    alerts.push({
      level: "error",
      event: "reconciliation_mismatch",
      details: { reconciliationMismatch: metrics.reconciliationMismatch },
    });
  }
  if (metrics.killSwitchCount > 0) {
    alerts.push({
      level: "error",
      event: "kill_switch",
      details: { killSwitchCount: metrics.killSwitchCount },
    });
  }
  if (metrics.positionQuantity !== 0 && !metrics.protectiveCoverage) {
    alerts.push({
      level: "error",
      event: "unprotected_position",
      details: { positionQuantity: metrics.positionQuantity },
    });
  }
  return alerts;
}

export function metricSnapshotLog(
  metrics: RuntimeMetrics,
  context: {
    strategyId: string;
    instanceId: string;
    symbol: string;
    now: number;
  },
): StrategyLog {
  return {
    timestamp: new Date(context.now).toISOString(),
    level: "info",
    strategyId: context.strategyId,
    instanceId: context.instanceId,
    symbol: context.symbol,
    event: "metrics",
    details: { ...metrics },
  };
}
