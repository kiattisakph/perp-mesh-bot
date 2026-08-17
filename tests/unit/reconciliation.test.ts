import { describe, expect, it } from "vitest";
import {
  reconcile,
  restartIntents,
} from "../../src/application/reconciliation-service";
import {
  foreignOrder,
  longPosition,
  testOrder,
  testOwnership,
} from "../helpers/trading-fixtures";

const ownership = testOwnership();

describe("reconciliation and restart", () => {
  it("does not duplicate a matching owned order after restart", () => {
    const stop = testOrder(ownership, {
      purpose: "stop",
      sequence: 2,
      side: "SELL",
      type: "STOP_MARKET",
      reduceOnly: true,
      stopPrice: 99_000,
      quantity: 0.001,
    });
    const expected = {
      type: "PLACE_STOP" as const,
      strategyId: "trend",
      symbol: "BTCUSDT",
      side: "SELL" as const,
      stopPrice: 99_000,
      quantity: 0.001,
      reduceOnly: true as const,
    };
    const decision = reconcile({
      expectedIntents: [expected],
      openOrders: [stop],
      position: longPosition(),
      ownership,
      reconciling: true,
    });
    expect(decision.keep).toEqual([stop]);
    expect(decision.cancelOwned).toEqual([]);
    expect(decision.missingPlaces).toEqual([]);
    expect(decision.allowEntry).toBe(false);
    expect(restartIntents(decision, "trend")).toEqual([]);
  });

  it("cancels unexpected owned orders and never foreign ones", () => {
    const unexpected = testOrder(ownership, {
      purpose: "entry",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 90_000,
    });
    const foreign = foreignOrder();
    const decision = reconcile({
      expectedIntents: [],
      openOrders: [unexpected, foreign],
      position: null,
      ownership,
      reconciling: true,
    });
    expect(decision.foreign).toEqual([foreign]);
    expect(decision.cancelOwned).toEqual([unexpected]);
    expect(restartIntents(decision, "trend")).toEqual([
      {
        type: "CANCEL",
        strategyId: "trend",
        orderIds: [unexpected.clientOrderId],
      },
    ]);
  });

  it("blocks entry intents until reconciliation finishes", () => {
    const entry = {
      type: "PLACE_MARKET" as const,
      strategyId: "trend",
      symbol: "BTCUSDT",
      side: "BUY" as const,
      quantity: 0.001,
      reduceOnly: false,
      reason: "signal",
    };
    const decision = reconcile({
      expectedIntents: [entry],
      openOrders: [],
      position: null,
      ownership,
      reconciling: true,
    });
    expect(decision.allowEntry).toBe(false);
    expect(decision.missingPlaces).toEqual([]);
    expect(restartIntents(decision, "trend")).toEqual([]);
  });

  it("flags an unprotected position so protection can be placed immediately", () => {
    const decision = reconcile({
      expectedIntents: [],
      openOrders: [],
      position: longPosition(),
      ownership,
      reconciling: true,
    });
    expect(decision.unprotectedPosition).toBe(true);
  });
});
