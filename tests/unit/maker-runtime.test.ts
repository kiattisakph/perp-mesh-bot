import { describe, expect, it } from "vitest";
import { isEntryIntent } from "../../src/domain/intent";
import type { OrderBook } from "../../src/domain/market";
import type { FuturesPosition } from "../../src/domain/account";
import type { StrategySnapshot } from "../../src/domain/strategy";
import {
  ExecutionService,
  IntentPipeline,
} from "../../src/application";
import { RateLimitError } from "../../src/infrastructure/binance-usdm/errors";
import { mapOrderTradeFill } from "../../src/infrastructure/binance-usdm/mapper";
import { RateLimitMachine } from "../../src/risk/rate-limit";
import {
  CancelReplaceBudget,
  FillTracker,
  MakerRuntime,
  evaluateMaker,
  type MakerConfig,
  type MakerFillEvent,
} from "../../src/strategies/maker";
import { FakeVenue } from "../helpers/fake-venue";
import { readFixture } from "../helpers/read-fixture";
import {
  btcPrecision,
  longPosition,
  testAccount,
  testOrder,
  testOwnership,
  testRiskContext,
} from "../helpers/trading-fixtures";

const NOW = 10_000;
const ownership = testOwnership("maker", "a1");

function makerConfig(
  variant: MakerConfig["variant"] = "classic",
  overrides: Partial<MakerConfig> = {},
): MakerConfig {
  return {
    variant,
    tradeQuantity: 0.001,
    lossLimitUsdt: 2,
    maxCloseSlippageFraction: 0.05,
    feedStaleMs: 10_000,
    entryDepthLevel: 1,
    bidOffset: 0,
    askOffset: 0,
    repriceTicks: 2,
    minDwellMs: 1_500,
    depthLevels: 10,
    skipRatio: 3,
    forcedExitRatio: 6,
    closeTickOffset: 1,
    recentFillMs: 60_000,
    ...overrides,
  };
}

function bookAt(bid: number, ask: number, eventTime = NOW): OrderBook {
  return {
    symbol: "BTCUSDT",
    bids: [{ price: bid, quantity: 1 }],
    asks: [{ price: ask, quantity: 1 }],
    eventTime,
    sequence: 1,
  };
}

function snapshot(input: {
  position?: FuturesPosition | null;
  openOrders?: StrategySnapshot["openOrders"];
  book?: OrderBook;
  markPrice?: number;
  lifecycle?: StrategySnapshot["lifecycle"];
  rateLimitState?: StrategySnapshot["rateLimitState"];
  now?: number;
  strategyId?: string;
} = {}): StrategySnapshot {
  const position = input.position === undefined ? null : input.position;
  const mark = input.markPrice ?? 100_000;
  return {
    strategyId: input.strategyId ?? "maker",
    instanceId: "a1",
    symbol: "BTCUSDT",
    lifecycle: input.lifecycle ?? "READY",
    rateLimitState: input.rateLimitState ?? "NORMAL",
    account: testAccount(position),
    position,
    openOrders: input.openOrders ?? [],
    orderBook: input.book ?? bookAt(100_000, 100_000.2),
    ticker: {
      symbol: "BTCUSDT",
      lastPrice: mark,
      markPrice: mark,
      eventTime: NOW,
    },
    markPrice: mark,
    precision: btcPrecision,
    now: input.now ?? NOW,
  };
}

function fillEventFromFixture(): MakerFillEvent {
  const mapped = mapOrderTradeFill(readFixture("order-trade-update-partial.json"));
  return {
    symbol: mapped.order.symbol,
    clientOrderId: mapped.order.clientOrderId,
    executionType: mapped.executionType,
    orderStatus: mapped.order.status,
    side: mapped.order.side,
    reduceOnly: mapped.order.reduceOnly,
    lastFilledQuantity: mapped.lastFilledQuantity,
    accumulatedFilledQuantity: mapped.order.filledQuantity,
    lastFillPrice: mapped.lastFillPrice,
    averageFillPrice: mapped.averageFillPrice,
    eventTime: mapped.eventTime,
  };
}

describe("Maker partial fill → exit-only", () => {
  it("cancels leftover entries and quotes only a reduce-only exit", () => {
    const bid = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100_000,
      quantity: 0.002,
      filledQuantity: 0.001,
      status: "PARTIALLY_FILLED",
    });
    const ask = testOrder(ownership, {
      purpose: "ask",
      sequence: 2,
      side: "SELL",
      reduceOnly: false,
      price: 100_000.2,
    });
    const result = evaluateMaker({
      snapshot: snapshot({
        position: longPosition(0.001, 100_000),
        openOrders: [bid, ask],
      }),
      config: makerConfig(),
      ownership,
    });
    expect(result.state.phase).toBe("POSITION_EXIT_ONLY");
    expect(
      result.intents.some(
        (intent) =>
          intent.type === "PLACE_LIMIT" && intent.reduceOnly === false,
      ),
    ).toBe(false);
    const cancels = result.intents.filter((intent) => intent.type === "CANCEL");
    const canceled = new Set(cancels.flatMap((intent) => intent.orderIds));
    expect(canceled.has(bid.clientOrderId)).toBe(true);
    expect(canceled.has(ask.clientOrderId)).toBe(true);
    expect(result.intents).toContainEqual(
      expect.objectContaining({
        type: "PLACE_LIMIT",
        side: "SELL",
        reduceOnly: true,
        quantity: 0.001,
      }),
    );
  });
});

describe("Maker reprice dwell and budget", () => {
  it("does not reprice inside dwell or below MAKER_REPRICE_TICKS", () => {
    const liveBid = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100_000,
      updateTime: NOW - 200,
    });
    const liveAsk = testOrder(ownership, {
      purpose: "ask",
      sequence: 2,
      side: "SELL",
      reduceOnly: false,
      price: 100_000.2,
      updateTime: NOW - 200,
    });
    const moved = evaluateMaker({
      snapshot: snapshot({
        openOrders: [liveBid, liveAsk],
        book: bookAt(99_999.5, 99_999.7),
      }),
      config: makerConfig(),
      ownership,
    });
    expect(moved.intents).toEqual([]);

    const oneTick = evaluateMaker({
      snapshot: snapshot({
        openOrders: [liveBid, liveAsk],
        book: bookAt(99_999.9, 100_000.1),
        now: NOW + 5_000,
      }),
      config: makerConfig(),
      ownership,
    });
    expect(oneTick.intents).toEqual([]);
  });

  it("reprices after dwell when the move is at least MAKER_REPRICE_TICKS", () => {
    const liveBid = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100_000,
      updateTime: NOW - 2_000,
    });
    const result = evaluateMaker({
      snapshot: snapshot({
        openOrders: [liveBid],
        book: bookAt(99_999.5, 99_999.7),
      }),
      config: makerConfig(),
      ownership,
    });
    expect(result.intents[0]).toMatchObject({
      type: "CANCEL",
      orderIds: [liveBid.clientOrderId],
    });
    expect(result.intents[1]).toMatchObject({
      type: "PLACE_LIMIT",
      side: "BUY",
      postOnly: true,
      reduceOnly: false,
    });
  });

  it("stops further quote cancel/replace once the injected per-minute budget is spent", () => {
    const budget = new CancelReplaceBudget(2);
    const first = evaluateMaker({
      snapshot: snapshot(),
      config: makerConfig("classic", { minDwellMs: 1, repriceTicks: 0 }),
      ownership,
      budget,
    });
    const places = first.intents.filter((intent) => intent.type === "PLACE_LIMIT");
    expect(places).toHaveLength(2);

    const live = [
      testOrder(ownership, {
        purpose: "bid",
        sequence: 1,
        side: "BUY",
        reduceOnly: false,
        price: 100_000,
        updateTime: 1,
      }),
      testOrder(ownership, {
        purpose: "ask",
        sequence: 2,
        side: "SELL",
        reduceOnly: false,
        price: 100_000.2,
        updateTime: 1,
      }),
    ];
    const second = evaluateMaker({
      snapshot: snapshot({
        openOrders: live,
        book: bookAt(99_990, 99_990.2),
        now: NOW + 1,
      }),
      config: makerConfig("classic", { minDwellMs: 1, repriceTicks: 0 }),
      ownership,
      budget,
    });
    expect(
      second.intents.some(
        (intent) => intent.type === "CANCEL" || intent.type === "PLACE_LIMIT",
      ),
    ).toBe(false);
  });
});

describe("Maker 429 does not storm quotes", () => {
  it("keeps existing quotes and still allows protection while DEGRADED/PAUSED", () => {
    const liveBid = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100_000,
    });
    const liveAsk = testOrder(ownership, {
      purpose: "ask",
      sequence: 2,
      side: "SELL",
      reduceOnly: false,
      price: 100_000.2,
    });
    const degraded = evaluateMaker({
      snapshot: snapshot({
        openOrders: [liveBid, liveAsk],
        book: bookAt(99_990, 99_990.2),
        rateLimitState: "DEGRADED",
      }),
      config: makerConfig("classic", { minDwellMs: 1, repriceTicks: 0 }),
      ownership,
    });
    expect(degraded.intents).toEqual([]);
    expect(degraded.state.phase).toBe("DEGRADED");

    const paused = evaluateMaker({
      snapshot: snapshot({
        openOrders: [liveBid, liveAsk],
        book: bookAt(99_990, 99_990.2),
        rateLimitState: "PAUSED",
      }),
      config: makerConfig("classic", { minDwellMs: 1, repriceTicks: 0 }),
      ownership,
    });
    expect(paused.intents).toEqual([]);
    expect(paused.state.phase).toBe("PAUSED");
  });

  it("does not emit a cancel/replace burst through the pipeline after a 429", async () => {
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(),
    });
    const execution = new ExecutionService(venue, ownership);
    const rateLimit = new RateLimitMachine({
      cleanWindowMs: 60_000,
      pausedCooldownMs: 60_000,
      repeated429WhileDegraded: 1,
    });
    const pipeline = new IntentPipeline(execution, rateLimit);
    const first = evaluateMaker({
      snapshot: snapshot(),
      config: makerConfig(),
      ownership,
    });
    await pipeline.run(
      first.intents,
      testRiskContext(ownership, {
        openOrders: [],
        markPrice: 100_000,
        closeCandidatePrice: 100_000,
      }),
    );
    expect(venue.placeCalls.length).toBe(2);

    venue.nextPlaceError = new RateLimitError(429);
    const live = await venue.fetchOpenOrders("BTCUSDT");
    const retry = evaluateMaker({
      snapshot: snapshot({
        openOrders: live,
        book: bookAt(99_990, 99_990.2),
        now: NOW + 5_000,
      }),
      config: makerConfig("classic", { minDwellMs: 1, repriceTicks: 0 }),
      ownership,
    });
    await expect(
      pipeline.run(
        retry.intents,
        testRiskContext(ownership, {
          openOrders: live,
          markPrice: 99_990,
          closeCandidatePrice: 99_990,
        }),
      ),
    ).rejects.toMatchObject({ name: "RateLimitError" });
    expect(rateLimit.state).toBe("DEGRADED");

    const after = evaluateMaker({
      snapshot: snapshot({
        openOrders: live,
        book: bookAt(99_980, 99_980.2),
        rateLimitState: rateLimit.state,
        now: NOW + 10_000,
      }),
      config: makerConfig("classic", { minDwellMs: 1, repriceTicks: 0 }),
      ownership,
    });
    expect(after.intents).toEqual([]);
    expect(venue.placeCalls.length).toBe(3);
    expect(venue.cancelAllOrdersCalls).toBe(0);
  });
});

describe("Maker restart / reconcile", () => {
  it("does not cancel matching quotes while reconciling when flat", () => {
    const liveBid = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100_000,
    });
    const liveAsk = testOrder(ownership, {
      purpose: "ask",
      sequence: 2,
      side: "SELL",
      reduceOnly: false,
      price: 100_000.2,
    });
    const result = evaluateMaker({
      snapshot: snapshot({
        openOrders: [liveBid, liveAsk],
        lifecycle: "RECONCILING",
      }),
      config: makerConfig(),
      ownership,
    });
    expect(result.intents).toEqual([]);
    expect(result.state.phase).toBe("RECONCILING");
  });

  it("places a reduce-only exit immediately when restarting in position", () => {
    const result = evaluateMaker({
      snapshot: snapshot({
        position: longPosition(),
        lifecycle: "RECONCILING",
        openOrders: [],
      }),
      config: makerConfig(),
      ownership,
    });
    expect(result.state.phase).toBe("RECONCILING");
    expect(result.intents.some(isEntryIntent)).toBe(false);
    expect(result.intents).toContainEqual(
      expect.objectContaining({
        type: "PLACE_LIMIT",
        side: "SELL",
        reduceOnly: true,
      }),
    );
  });
});

describe("Fill tracker from execution reports", () => {
  it("keeps a TRADE fill after the order has left open orders", () => {
    const tracker = new FillTracker();
    const event = fillEventFromFixture();
    expect(event.executionType).toBe("TRADE");
    tracker.apply(event);
    expect(tracker.recentFill(event.eventTime, 60_000)?.price).toBe(20_000);

    const runtime = new MakerRuntime(makerConfig("liquidity"));
    runtime.onExecutionReport(event);
    const result = runtime.evaluate({
      snapshot: snapshot({
        strategyId: "liquidity-maker",
        position: longPosition(0.001, 19_000),
        openOrders: [],
        book: bookAt(20_000, 20_000.2, event.eventTime),
        markPrice: 20_000,
        now: event.eventTime,
      }),
      ownership: testOwnership("liquidity-maker", "a1"),
    });
    const exit = result.intents.find(
      (intent) => intent.type === "PLACE_LIMIT" && intent.reduceOnly,
    );
    expect(exit).toMatchObject({ type: "PLACE_LIMIT", side: "SELL" });
    if (exit !== undefined && exit.type === "PLACE_LIMIT") {
      expect(exit.price).toBeGreaterThan(20_000);
    }
  });

  it("does not infer a fill from the open-order array alone", () => {
    const tracker = new FillTracker();
    const partial = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      status: "PARTIALLY_FILLED",
      filledQuantity: 0.001,
      quantity: 0.002,
      price: 100_000,
    });
    expect(tracker.snapshot()).toBeUndefined();
    tracker.reconcileFromPosition({
      quantity: 0.001,
      entryPrice: 100_000,
      now: NOW,
    });
    expect(tracker.snapshot()?.price).toBe(100_000);
    expect(partial.status).toBe("PARTIALLY_FILLED");
  });
});
