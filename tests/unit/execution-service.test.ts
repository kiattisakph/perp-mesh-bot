import { describe, expect, it } from "vitest";
import { ExecutionService } from "../../src/application/execution-service";
import { IntentPipeline } from "../../src/application/intent-pipeline";
import { RateLimitMachine } from "../../src/risk/rate-limit";
import { FakeVenue } from "../helpers/fake-venue";
import {
  btcPrecision,
  foreignOrder,
  testAccount,
  testOrder,
  testOwnership,
  testRiskContext,
} from "../helpers/trading-fixtures";

const ownership = testOwnership();

describe("execution service", () => {
  it("places reduce-only closes and never uses symbol-wide cancel", async () => {
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(),
    });
    const execution = new ExecutionService(venue, ownership);
    const result = await execution.execute(
      [
        {
          type: "PLACE_MARKET",
          strategyId: "trend",
          symbol: "BTCUSDT",
          side: "SELL",
          quantity: 0.001,
          reduceOnly: true,
          reason: "flatten",
        },
      ],
      { symbol: "BTCUSDT", ownership, openOrders: [] },
    );
    expect(result.placed[0]?.reduceOnly).toBe(true);
    expect(venue.placeCalls[0]?.intent).toMatchObject({ reduceOnly: true });
    expect(venue.cancelAllOrdersCalls).toBe(0);
  });

  it("cancels only bot-owned orders and leaves foreign orders standing", async () => {
    const owned = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100,
    });
    const foreign = foreignOrder();
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(),
      orders: [owned, foreign],
    });
    const execution = new ExecutionService(venue, ownership);
    await execution.execute(
      [
        {
          type: "CANCEL",
          strategyId: "trend",
          orderIds: [owned.clientOrderId, foreign.clientOrderId],
        },
      ],
      { symbol: "BTCUSDT", ownership, openOrders: [owned, foreign] },
    );
    expect(venue.orders.get(owned.clientOrderId)?.status).toBe("CANCELED");
    expect(venue.orders.get(foreign.clientOrderId)?.status).toBe("NEW");
    expect(venue.cancelAllOrdersCalls).toBe(0);
    expect(
      venue.cancelCalls.every(
        (call) => call.origClientOrderId !== foreign.clientOrderId,
      ),
    ).toBe(true);
  });

  it("queries before deciding status when cancel result is unknown", async () => {
    const owned = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100,
    });
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(),
      orders: [owned],
    });
    venue.failNextCancelUnknown();
    const execution = new ExecutionService(venue, ownership);
    const result = await execution.execute(
      [{ type: "CANCEL", strategyId: "trend", orderIds: [owned.clientOrderId] }],
      { symbol: "BTCUSDT", ownership, openOrders: [owned] },
    );
    expect(result.unknownCancelsQueried).toBe(1);
    expect(venue.queryCalls).toBeGreaterThanOrEqual(1);
    expect(venue.orders.get(owned.clientOrderId)?.status).toBe("NEW");
  });

  it("queries instead of retrying a duplicate after unknown execution status", async () => {
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(),
    });
    venue.failNextPlaceUnknown();
    const execution = new ExecutionService(venue, ownership);
    const result = await execution.execute(
      [
        {
          type: "PLACE_LIMIT",
          strategyId: "trend",
          symbol: "BTCUSDT",
          side: "BUY",
          price: 90_000,
          quantity: 0.001,
          postOnly: true,
          reduceOnly: false,
        },
      ],
      { symbol: "BTCUSDT", ownership, openOrders: [] },
    );
    expect(venue.placeCalls).toHaveLength(1);
    expect(result.placed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it("CANCEL_OWNED cancels every owned live order for the symbol", async () => {
    const owned = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100,
    });
    const foreign = foreignOrder();
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(),
      orders: [owned, foreign],
    });
    const execution = new ExecutionService(venue, ownership);
    await execution.execute(
      [{ type: "CANCEL_OWNED", strategyId: "trend", symbol: "BTCUSDT" }],
      { symbol: "BTCUSDT", ownership, openOrders: [owned, foreign] },
    );
    expect(venue.orders.get(owned.clientOrderId)?.status).toBe("CANCELED");
    expect(venue.orders.get(foreign.clientOrderId)?.status).toBe("NEW");
  });
});

describe("intent pipeline 429", () => {
  it("degrades on 429 and then rejects a later entry while keeping protection", async () => {
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(),
    });
    venue.failNextPlace429();
    const rateLimit = new RateLimitMachine({
      cleanWindowMs: 1000,
      pausedCooldownMs: 1000,
      repeated429WhileDegraded: 1,
    });
    const execution = new ExecutionService(venue, ownership);
    const pipeline = new IntentPipeline(execution, rateLimit, undefined, () => 0);
    const context = testRiskContext(ownership);
    await expect(
      pipeline.run(
        [
          {
            type: "PLACE_MARKET",
            strategyId: "trend",
            symbol: "BTCUSDT",
            side: "BUY",
            quantity: 0.001,
            reduceOnly: false,
            reason: "entry",
          },
        ],
        context,
      ),
    ).rejects.toMatchObject({ name: "RateLimitError" });
    expect(rateLimit.state).toBe("DEGRADED");

    const after = await pipeline.run(
      [
        {
          type: "PLACE_MARKET",
          strategyId: "trend",
          symbol: "BTCUSDT",
          side: "BUY",
          quantity: 0.001,
          reduceOnly: false,
          reason: "entry",
        },
        {
          type: "PLACE_STOP",
          strategyId: "trend",
          symbol: "BTCUSDT",
          side: "SELL",
          stopPrice: 99_000,
          quantity: 0.001,
          reduceOnly: true,
        },
      ],
      {
        ...testRiskContext(ownership, {
          position: {
            symbol: "BTCUSDT",
            quantity: 0.001,
            entryPrice: 100_000,
            markPrice: 100_000,
            unrealizedPnl: 0,
            leverage: 3,
            marginMode: "isolated",
            updateTime: 1,
          },
        }),
        rateLimitState: rateLimit.state,
      },
    );
    expect(after.risk.rejected[0]?.reason).toBe("rate_limit");
    expect(after.execution?.placed[0]?.type).toBe("STOP_MARKET");
    expect(after.execution?.placed[0]?.reduceOnly).toBe(true);
  });
});
