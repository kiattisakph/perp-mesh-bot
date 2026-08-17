import { describe, expect, it } from "vitest";
import {
  RuntimeMetricsCollector,
  alertsFromMetrics,
  emptyRuntimeMetrics,
  metricSnapshotLog,
} from "../../src/application/production";
import { emitStrategyLog } from "../../src/application/logger";

describe("runtime metrics alerts", () => {
  it("snapshots the documented metrics list", () => {
    const collector = new RuntimeMetricsCollector();
    collector.recordWsState("connected");
    collector.recordFeedEvent(1_000);
    collector.recordRestLatency(12);
    collector.recordRestWsError();
    collector.recordOrderCreate();
    collector.recordOrderCancel();
    collector.record429();
    collector.recordOpenOrderCount(2);
    collector.recordPosition({
      quantity: 0.001,
      notional: 100,
      unrealizedPnl: 1,
    });
    collector.recordStrategyState("RUNNING");
    collector.recordProtectiveCoverage(true);
    collector.recordReconciliationMismatch(0);
    const metrics = collector.snapshot(1_500);
    expect(metrics).toMatchObject({
      wsConnectionState: "connected",
      lastFeedUpdateAgeMs: 500,
      restLatencyMs: 12,
      restWsErrorCount: 1,
      orderCreateCount: 1,
      orderCancelCount: 1,
      rateLimit429Count: 1,
      openOrderCount: 2,
      positionQuantity: 0.001,
      positionNotional: 100,
      unrealizedPnl: 1,
      strategyState: "RUNNING",
      protectiveCoverage: true,
      reconciliationMismatch: 0,
      killSwitchCount: 0,
    });
  });

  it("alerts on stale feed, 429, mismatch, kill switch, and uncovered position", () => {
    const metrics = emptyRuntimeMetrics("RUNNING");
    metrics.wsConnectionState = "disconnected";
    metrics.lastFeedUpdateAgeMs = 11_000;
    metrics.rateLimit429Count = 1;
    metrics.reconciliationMismatch = 2;
    metrics.killSwitchCount = 1;
    metrics.positionQuantity = 0.001;
    metrics.protectiveCoverage = false;
    const alerts = alertsFromMetrics(metrics, { feedStaleMs: 10_000 });
    expect(alerts.map((row) => row.event)).toEqual([
      "ws_disconnected",
      "feed_stale",
      "rate_limit",
      "reconciliation_mismatch",
      "kill_switch",
      "unprotected_position",
    ]);
  });

  it("does not put secrets in metric logs", () => {
    const lines: string[] = [];
    emitStrategyLog(
      metricSnapshotLog(emptyRuntimeMetrics(), {
        strategyId: "guardian",
        instanceId: "local-01",
        symbol: "BTCUSDT",
        now: 0,
      }),
      (line) => lines.push(line),
    );
    emitStrategyLog(
      {
        timestamp: "0",
        level: "info",
        strategyId: "guardian",
        instanceId: "local-01",
        symbol: "BTCUSDT",
        event: "startup",
        details: {
          apiKey: "secret-key",
          apiSecret: "secret-secret",
          signature: "sig",
          authorization: "Bearer x",
          venue: "testnet",
        },
      },
      (line) => lines.push(line),
    );
    const joined = lines.join("\n");
    expect(joined).not.toMatch(/secret-key/);
    expect(joined).not.toMatch(/secret-secret/);
    expect(joined).not.toMatch(/Bearer/);
    expect(joined).toMatch(/"venue":"testnet"/);
  });
});
