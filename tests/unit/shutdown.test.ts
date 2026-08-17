import { describe, expect, it } from "vitest";
import { ExecutionService } from "../../src/application/execution-service";
import { shutdownIntents, ShutdownService } from "../../src/application/shutdown-service";
import { FakeVenue } from "../helpers/fake-venue";
import {
  btcPrecision,
  foreignOrder,
  longPosition,
  testAccount,
  testOrder,
  testOwnership,
} from "../helpers/trading-fixtures";

const ownership = testOwnership();

describe("shutdown", () => {
  const ownedEntry = testOrder(ownership, {
    purpose: "entry",
    sequence: 1,
    side: "BUY",
    reduceOnly: false,
    price: 90_000,
  });
  const ownedStop = testOrder(ownership, {
    purpose: "stop",
    sequence: 2,
    side: "SELL",
    type: "STOP_MARKET",
    reduceOnly: true,
    stopPrice: 98_000,
  });
  const foreign = foreignOrder();

  it("default cancel-owned cancels every owned live order and not foreign ones", () => {
    const intents = shutdownIntents("cancel-owned", {
      symbol: "BTCUSDT",
      strategyId: "trend",
      ownership,
      position: longPosition(),
      openOrders: [ownedEntry, ownedStop, foreign],
      precision: btcPrecision,
      markPrice: 100_000,
      closeCandidatePrice: 100_000,
      maxCloseSlippageFraction: 0.005,
    });
    expect(intents).toEqual([
      {
        type: "CANCEL",
        strategyId: "trend",
        orderIds: [ownedEntry.clientOrderId, ownedStop.clientOrderId],
      },
    ]);
  });

  it("flatten-on-exit uses the kill-switch flatten path with reduce-only close", () => {
    const intents = shutdownIntents("flatten", {
      symbol: "BTCUSDT",
      strategyId: "trend",
      ownership,
      position: longPosition(),
      openOrders: [ownedEntry, ownedStop, foreign],
      precision: btcPrecision,
      markPrice: 100_000,
      closeCandidatePrice: 100_000,
      maxCloseSlippageFraction: 0.005,
    });
    expect(intents[0]).toMatchObject({
      type: "CANCEL",
      orderIds: [ownedEntry.clientOrderId],
    });
    expect(intents[1]).toMatchObject({
      type: "PLACE_MARKET",
      reduceOnly: true,
      side: "SELL",
    });
  });

  it("executes owned-only cancels and never calls cancel-all", async () => {
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(longPosition()),
      orders: [ownedEntry, ownedStop, foreign],
    });
    const execution = new ExecutionService(venue, ownership);
    const shutdown = new ShutdownService(execution, venue);
    await shutdown.shutdown("cancel-owned", {
      symbol: "BTCUSDT",
      strategyId: "trend",
      ownership,
      position: longPosition(),
      openOrders: [ownedEntry, ownedStop, foreign],
      precision: btcPrecision,
      markPrice: 100_000,
      closeCandidatePrice: 100_000,
      maxCloseSlippageFraction: 0.005,
    });
    expect(venue.orders.get(ownedEntry.clientOrderId)?.status).toBe("CANCELED");
    expect(venue.orders.get(ownedStop.clientOrderId)?.status).toBe("CANCELED");
    expect(venue.orders.get(foreign.clientOrderId)?.status).toBe("NEW");
    expect(venue.cancelAllOrdersCalls).toBe(0);
  });
});
