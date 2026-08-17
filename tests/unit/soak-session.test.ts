import { describe, expect, it } from "vitest";
import { ExecutionService } from "../../src/application/execution-service";
import {
  ManualClock,
  SOAK_MIN_WINDOW_MS,
  SOAK_STRATEGIES,
  runSoakSession,
  type SoakStreamChaos,
} from "../../src/application/soak";
import type { StrategyName } from "../../src/config/schema";
import type { StrategySnapshot } from "../../src/domain/strategy";
import { evaluateGuardian } from "../../src/strategies/guardian";
import { FakeVenue } from "../helpers/fake-venue";
import {
  btcPrecision,
  foreignOrder,
  longPosition,
  testAccount,
  testOrder,
  testOwnership,
} from "../helpers/trading-fixtures";

const HOUR_MS = 60 * 60 * 1000;
const ownership = testOwnership("guardian", "soak");

function chaos(): SoakStreamChaos & { public: number; user: number } {
  const state = {
    public: 0,
    user: 0,
    injectPublicDisconnect() {
      state.public += 1;
    },
    injectUserDisconnect() {
      state.user += 1;
    },
  };
  return state;
}

function liveOrders(venue: FakeVenue) {
  return [...venue.orders.values()].filter(
    (order) => order.status === "NEW" || order.status === "PARTIALLY_FILLED",
  );
}

function snapshotFromVenue(
  venue: FakeVenue,
  strategyId: StrategyName,
): StrategySnapshot {
  const position =
    venue.account.positions.find((row) => row.symbol === "BTCUSDT") ?? null;
  return {
    strategyId,
    instanceId: ownership.instanceId,
    symbol: "BTCUSDT",
    lifecycle: "RUNNING",
    rateLimitState: "NORMAL",
    account: venue.account,
    position: position === null || position.quantity === 0 ? null : position,
    openOrders: liveOrders(venue),
    markPrice: 100_000,
    precision: btcPrecision,
    now: 0,
  };
}

describe("soak session", () => {
  it("completes a compressed 24h window with chaos, audits, and both kill-switch modes", async () => {
    const entry = testOrder(ownership, {
      purpose: "entry",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 99_000,
    });
    const stop = testOrder(ownership, {
      purpose: "stop",
      sequence: 2,
      side: "SELL",
      type: "STOP_MARKET",
      reduceOnly: true,
      stopPrice: 98_000,
    });
    const foreign = foreignOrder();
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(longPosition()),
      orders: [entry, stop, foreign],
    });
    const injected = chaos();
    const report = await runSoakSession({
      strategyId: "guardian",
      instanceId: ownership.instanceId,
      symbol: "BTCUSDT",
      ownership,
      venue,
      execution: ExecutionService.fromOpenOrders(venue, ownership, [
        entry,
        stop,
        foreign,
      ]),
      chaos: injected,
      clock: new ManualClock(0),
      windowMs: SOAK_MIN_WINDOW_MS,
      tickMs: HOUR_MS,
      disconnectAtMs: [2 * HOUR_MS, 8 * HOUR_MS],
      killSwitchCancelOnlyAtMs: 20 * HOUR_MS,
      killSwitchFlattenAtMs: 22 * HOUR_MS,
      maxCloseSlippageFraction: 0.005,
      policy: (snapshot) =>
        evaluateGuardian({
          snapshot,
          config: {
            lossLimitUsdt: 2,
            trailingActivationProfitUsdt: 3,
            trailingCallbackRate: 0.2,
            profitLockTriggerUsdt: 2,
            profitLockStepUsdt: 1,
          },
          ownership,
        }).intents,
      snapshot: () => snapshotFromVenue(venue, "guardian"),
      cancelAllOrdersCalls: () => venue.cancelAllOrdersCalls,
    });

    expect(report.elapsedMs).toBe(SOAK_MIN_WINDOW_MS);
    expect(report.wsDisconnects).toBe(2);
    expect(injected.public).toBe(1);
    expect(injected.user).toBe(1);
    expect(report.killSwitchCancelOnly).toBe(true);
    expect(report.killSwitchFlatten).toBe(true);
    expect(report.flattenReduceOnly).toBe(true);
    expect(report.orphanOrders).toEqual([]);
    expect(report.positionMismatches).toEqual([]);
    expect(report.timersOutstanding).toBe(0);
    expect(report.cancelAllOrdersCalls).toBe(0);
    expect(venue.orders.get(foreign.clientOrderId)?.status).toBe("NEW");
    expect(venue.orders.get(entry.clientOrderId)?.status).toBe("CANCELED");
    expect(venue.account.positions[0]?.quantity).toBe(0);
    expect(report.checklist.passed).toBe(true);
    expect(report.checklist.productionReady).toBe(false);
    expect(report.productionReady).toBe(false);
    expect(report.metrics.killSwitchCount).toBe(2);
    expect(report.metrics.wsConnectionState).toBe("connected");
  });

  it("soaks every production strategy including the maker family", async () => {
    expect(SOAK_STRATEGIES).toEqual([
      "guardian",
      "trend",
      "swing",
      "maker",
      "offset-maker",
      "liquidity-maker",
    ]);
    for (const strategyId of SOAK_STRATEGIES) {
      const strategyOwnership = testOwnership(strategyId, "soak");
      const entry = testOrder(strategyOwnership, {
        purpose: "entry",
        sequence: 1,
        side: "BUY",
        reduceOnly: false,
        price: 99_000,
      });
      const venue = new FakeVenue({
        precision: btcPrecision,
        account: testAccount(longPosition()),
        orders: [entry],
      });
      const report = await runSoakSession({
        strategyId,
        instanceId: strategyOwnership.instanceId,
        symbol: "BTCUSDT",
        ownership: strategyOwnership,
        venue,
        execution: ExecutionService.fromOpenOrders(venue, strategyOwnership, [
          entry,
        ]),
        chaos: chaos(),
        clock: new ManualClock(0),
        windowMs: SOAK_MIN_WINDOW_MS,
        tickMs: HOUR_MS,
        disconnectAtMs: [HOUR_MS, 3 * HOUR_MS],
        killSwitchCancelOnlyAtMs: 20 * HOUR_MS,
        killSwitchFlattenAtMs: 22 * HOUR_MS,
        maxCloseSlippageFraction: 0.005,
        policy: () => [],
        snapshot: () => snapshotFromVenue(venue, strategyId),
        cancelAllOrdersCalls: () => venue.cancelAllOrdersCalls,
      });
      expect(report.strategyId).toBe(strategyId);
      expect(report.checklist.passed).toBe(true);
      expect(report.productionReady).toBe(false);
      expect(report.wsDisconnects).toBeGreaterThanOrEqual(2);
      expect(venue.cancelAllOrdersCalls).toBe(0);
    }
  });
});
