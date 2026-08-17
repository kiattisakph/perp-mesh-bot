import { describe, expect, it } from "vitest";
import {
  auditOrphanOrders,
  auditPositionMismatch,
  evaluateSoakChecklist,
  leakSnapshot,
  OrderRateTracker,
  SOAK_MAX_WINDOW_MS,
  SOAK_MIN_WINDOW_MS,
  TrackedClock,
} from "../../src/application/soak";
import {
  foreignOrder,
  longPosition,
  testAccount,
  testOrder,
  testOwnership,
} from "../helpers/trading-fixtures";

const ownership = testOwnership("guardian", "a1");

describe("soak orphan and position audits", () => {
  it("ignores foreign orders and tracked owned orders", () => {
    const stop = testOrder(ownership, {
      purpose: "stop",
      sequence: 1,
      side: "SELL",
      type: "STOP_MARKET",
      reduceOnly: true,
      stopPrice: 98_000,
    });
    const orphans = auditOrphanOrders({
      trackedOrders: [stop],
      exchangeOpenOrders: [stop, foreignOrder()],
      ownership,
    });
    expect(orphans).toEqual([]);
  });

  it("flags an untracked bot-owned live order as an orphan", () => {
    const stray = testOrder(ownership, {
      purpose: "entry",
      sequence: 9,
      side: "BUY",
      reduceOnly: false,
      price: 99_000,
    });
    const orphans = auditOrphanOrders({
      trackedOrders: [],
      exchangeOpenOrders: [stray],
      ownership,
    });
    expect(orphans).toEqual([
      { clientOrderId: stray.clientOrderId, reason: "unexpected_owned" },
    ]);
  });

  it("flags a bot-owned id that does not parse", () => {
    const broken = {
      ...testOrder(ownership, {
        purpose: "entry",
        sequence: 1,
        side: "BUY",
        reduceOnly: false,
      }),
      clientOrderId: `${ownership.prefix}entry`,
    };
    const orphans = auditOrphanOrders({
      trackedOrders: [broken],
      exchangeOpenOrders: [broken],
      ownership,
    });
    expect(orphans).toEqual([
      { clientOrderId: broken.clientOrderId, reason: "unparsed_owned" },
    ]);
  });

  it("detects snapshot vs exchange position mismatch", () => {
    expect(
      auditPositionMismatch({
        symbol: "BTCUSDT",
        snapshotPosition: longPosition(0.001),
        exchangeAccount: testAccount(longPosition(0.002)),
      }),
    ).toEqual({
      symbol: "BTCUSDT",
      snapshotQuantity: 0.001,
      exchangeQuantity: 0.002,
    });
    expect(
      auditPositionMismatch({
        symbol: "BTCUSDT",
        snapshotPosition: longPosition(0.001),
        exchangeAccount: testAccount(longPosition(0.001)),
      }),
    ).toBeUndefined();
  });
});

describe("soak order rate", () => {
  it("records per-minute place and cancel counts", () => {
    const tracker = new OrderRateTracker();
    tracker.recordPlace(1_000, 2);
    tracker.recordCancel(2_000, 1);
    const buckets = tracker.buckets(2_000, 0);
    expect(buckets[0]).toEqual({
      minuteStart: 0,
      places: 2,
      cancels: 1,
      total: 3,
    });
  });

  it("flags a storm when 429 does not reduce the next minute's activity", () => {
    const tracker = new OrderRateTracker();
    tracker.recordPlace(10_000, 4);
    tracker.recordCancel(20_000, 2);
    tracker.record429(30_000);
    tracker.recordPlace(70_000, 4);
    tracker.recordCancel(80_000, 2);
    expect(tracker.hasStormAfter429(120_000, 0)).toBe(true);
  });

  it("does not flag a storm when activity drops after 429", () => {
    const tracker = new OrderRateTracker();
    tracker.recordPlace(10_000, 4);
    tracker.record429(20_000);
    tracker.recordPlace(70_000, 1);
    expect(tracker.hasStormAfter429(120_000, 0)).toBe(false);
  });

  it("flags unbounded strictly increasing per-minute totals", () => {
    const tracker = new OrderRateTracker();
    tracker.recordPlace(10_000, 1);
    tracker.recordPlace(70_000, 2);
    tracker.recordPlace(130_000, 3);
    expect(tracker.isUnbounded(180_000, 0)).toBe(true);
    const bounded = new OrderRateTracker();
    bounded.recordPlace(10_000, 2);
    bounded.recordPlace(70_000, 2);
    bounded.recordPlace(130_000, 1);
    expect(bounded.isUnbounded(180_000, 0)).toBe(false);
  });
});

describe("soak leaks and checklist", () => {
  it("counts outstanding timers and clears them", () => {
    const clock = new TrackedClock();
    clock.setInterval(() => undefined, 1_000);
    expect(leakSnapshot(clock).timersOutstanding).toBe(1);
    clock.clearAll();
    expect(leakSnapshot(clock).timersOutstanding).toBe(0);
  });

  it("passes the soak checklist without calling the bot production-ready", () => {
    const result = evaluateSoakChecklist({
      strategyId: "maker",
      windowMs: SOAK_MIN_WINDOW_MS,
      elapsedMs: SOAK_MIN_WINDOW_MS,
      minWindowMs: SOAK_MIN_WINDOW_MS,
      wsDisconnects: 2,
      orphanOrders: [],
      positionMismatches: [],
      timersOutstanding: 0,
      orderRatePerMinute: [],
      orderStorm: false,
      unboundedOrderRate: false,
      killSwitchCancelOnly: true,
      killSwitchFlatten: true,
      cancelAllOrdersCalls: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.productionReady).toBe(false);
    expect(result.items.multipleWsDisconnects).toBe(true);
    expect(result.items.noOrphanOrders).toBe(true);
    expect(result.items.noOrderStorm).toBe(true);
  });

  it("fails incomplete chaos, orphans, mismatch, leaks, and storms", () => {
    const result = evaluateSoakChecklist({
      strategyId: "trend",
      windowMs: SOAK_MAX_WINDOW_MS + 1,
      elapsedMs: 1,
      minWindowMs: SOAK_MIN_WINDOW_MS,
      wsDisconnects: 1,
      orphanOrders: [{ clientOrderId: "x", reason: "unexpected_owned" }],
      positionMismatches: [
        { symbol: "BTCUSDT", snapshotQuantity: 1, exchangeQuantity: 0 },
      ],
      timersOutstanding: 2,
      orderRatePerMinute: [],
      orderStorm: true,
      unboundedOrderRate: true,
      killSwitchCancelOnly: false,
      killSwitchFlatten: false,
      cancelAllOrdersCalls: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.productionReady).toBe(false);
    expect(result.failed).toEqual([
      "window_out_of_range",
      "window_incomplete",
      "ws_disconnects",
      "orphan_orders",
      "position_mismatch",
      "timer_leaks",
      "order_storm",
      "kill_switch_cancel_only",
      "kill_switch_flatten",
      "symbol_wide_cancel",
    ]);
  });
});
