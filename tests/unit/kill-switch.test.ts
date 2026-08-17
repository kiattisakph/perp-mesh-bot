import { describe, expect, it } from "vitest";
import { killSwitchIntents } from "../../src/risk/kill-switch";
import { ownedEntryClientOrderIds } from "../../src/application/ownership";
import {
  btcPrecision,
  foreignOrder,
  longPosition,
  testOrder,
  testOwnership,
} from "../helpers/trading-fixtures";

const ownership = testOwnership();

describe("kill switch", () => {
  const entry = testOrder(ownership, {
    purpose: "entry",
    sequence: 1,
    side: "BUY",
    type: "LIMIT",
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
  const openOrders = [entry, stop, foreign];
  const base = {
    symbol: "BTCUSDT",
    strategyId: "trend",
    position: longPosition(),
    entryClientOrderIds: ownedEntryClientOrderIds(openOrders, ownership),
    precision: btcPrecision,
    markPrice: 100_000,
    closeCandidatePrice: 100_000,
    maxCloseSlippageFraction: 0.005,
  };

  it("CANCEL_ONLY cancels owned entry orders, leaves the position, and keeps protection", () => {
    const intents = killSwitchIntents("CANCEL_ONLY", base);
    expect(intents).toEqual([
      {
        type: "CANCEL",
        strategyId: "trend",
        orderIds: [entry.clientOrderId],
      },
    ]);
    expect(intents.some((intent) => intent.type === "PLACE_MARKET")).toBe(false);
    expect(JSON.stringify(intents)).not.toContain(foreign.clientOrderId);
    expect(JSON.stringify(intents)).not.toContain(stop.clientOrderId);
  });

  it("CANCEL_AND_FLATTEN cancels owned entries then sends a reduce-only market close", () => {
    const intents = killSwitchIntents("CANCEL_AND_FLATTEN", base);
    expect(intents[0]).toEqual({
      type: "CANCEL",
      strategyId: "trend",
      orderIds: [entry.clientOrderId],
    });
    expect(intents[1]).toMatchObject({
      type: "PLACE_MARKET",
      side: "SELL",
      reduceOnly: true,
      reason: "kill_switch_flatten",
      quantity: 0.001,
    });
    expect(JSON.stringify(intents)).not.toContain(foreign.clientOrderId);
  });

  it("does not flatten when mark slippage fails and does not cancel protection", () => {
    const intents = killSwitchIntents("CANCEL_AND_FLATTEN", {
      ...base,
      entryClientOrderIds: ownedEntryClientOrderIds([stop], ownership),
      closeCandidatePrice: 99_000,
    });
    expect(intents.some((intent) => intent.type === "PLACE_MARKET")).toBe(false);
    expect(JSON.stringify(intents)).not.toContain(stop.clientOrderId);
  });
});
