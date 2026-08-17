import { describe, expect, it } from "vitest";
import { isEntryIntent } from "../../src/domain/intent";
import type { Candle } from "../../src/domain/market";
import type { FuturesPosition } from "../../src/domain/account";
import type { StrategySnapshot } from "../../src/domain/strategy";
import {
  ExecutionService,
  IntentPipeline,
} from "../../src/application";
import { RateLimitMachine } from "../../src/risk/rate-limit";
import {
  evaluateTrend,
  initialTrendState,
  type TrendConfig,
  type TrendState,
} from "../../src/strategies/trend";
import { FakeVenue } from "../helpers/fake-venue";
import {
  btcPrecision,
  longPosition,
  testAccount,
  testOrder,
  testOwnership,
  testRiskContext,
} from "../helpers/trading-fixtures";

const ownership = testOwnership("trend", "a1");

const trendConfig: TrendConfig = {
  tradeQuantity: 0.001,
  smaPeriod: 3,
  bollingerLength: 3,
  bollingerMultiplier: 2,
  minBandwidth: 0.001,
  entryCooldownMs: 60_000,
  lossLimitUsdt: 2,
  trailingActivationProfitUsdt: 3,
  trailingCallbackRate: 0.2,
  profitLockTriggerUsdt: 2,
  profitLockStepUsdt: 1,
};

const NOW = Date.UTC(2026, 7, 17, 10, 30, 45);

function closedCandles(closes: readonly number[]): Candle[] {
  return closes.map((close, index) => ({
    symbol: "BTCUSDT",
    interval: "1m",
    openTime: index * 60_000,
    closeTime: (index + 1) * 60_000 - 1,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    closed: true,
  }));
}

/** SMA = 100_000, bandwidth ≈ 0.065 > 0.001 */
const wideCloses = [98_000, 100_000, 102_000] as const;

function ticker(lastPrice: number, markPrice = lastPrice) {
  return {
    symbol: "BTCUSDT",
    lastPrice,
    markPrice,
    eventTime: NOW,
  };
}

function snapshot(input: {
  position?: FuturesPosition | null;
  openOrders?: StrategySnapshot["openOrders"];
  lastPrice?: number;
  markPrice?: number;
  closes?: readonly number[];
  extraOpenCandle?: number;
  lifecycle?: StrategySnapshot["lifecycle"];
  rateLimitState?: StrategySnapshot["rateLimitState"];
  now?: number;
} = {}): StrategySnapshot {
  const lastPrice = input.lastPrice ?? 100_001;
  const mark = input.markPrice ?? lastPrice;
  const candles = closedCandles(input.closes ?? wideCloses);
  if (input.extraOpenCandle !== undefined) {
    candles.push({
      symbol: "BTCUSDT",
      interval: "1m",
      openTime: candles.length * 60_000,
      closeTime: (candles.length + 1) * 60_000 - 1,
      open: input.extraOpenCandle,
      high: input.extraOpenCandle,
      low: input.extraOpenCandle,
      close: input.extraOpenCandle,
      volume: 1,
      closed: false,
    });
  }
  const position =
    input.position === undefined ? null : input.position;
  return {
    strategyId: "trend",
    instanceId: "a1",
    symbol: "BTCUSDT",
    lifecycle: input.lifecycle ?? "READY",
    rateLimitState: input.rateLimitState ?? "NORMAL",
    account: testAccount(position),
    position,
    openOrders: input.openOrders ?? [],
    ticker: ticker(lastPrice, mark),
    markPrice: mark,
    candles,
    precision: btcPrecision,
    now: input.now ?? NOW,
  };
}

function decide(
  input: Parameters<typeof snapshot>[0] = {},
  state?: TrendState,
): ReturnType<typeof evaluateTrend> {
  return evaluateTrend({
    snapshot: snapshot(input),
    config: trendConfig,
    ownership,
    state,
  });
}

describe("Trend cross and filters", () => {
  it("opens long on an SMA cross up when bandwidth passes", () => {
    const { intents, state } = decide(
      { lastPrice: 100_001 },
      { phase: "FLAT", previousPrice: 99_999 },
    );
    expect(state.phase).toBe("OPENING_LONG");
    expect(intents).toEqual([
      {
        type: "PLACE_MARKET",
        strategyId: "trend",
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 0.001,
        reduceOnly: false,
        reason: "trend_entry",
      },
    ]);
  });

  it("opens short on an SMA cross down when bandwidth passes", () => {
    const { intents, state } = decide(
      { lastPrice: 99_999 },
      { phase: "FLAT", previousPrice: 100_001 },
    );
    expect(state.phase).toBe("OPENING_SHORT");
    expect(intents[0]).toMatchObject({
      type: "PLACE_MARKET",
      side: "SELL",
      reduceOnly: false,
      reason: "trend_entry",
    });
  });

  it("does not open when fewer than max(smaPeriod, bollingerLength) closed klines are ready", () => {
    const { intents } = decide(
      { lastPrice: 100_001, closes: [98_000, 102_000] },
      { phase: "FLAT", previousPrice: 99_999 },
    );
    expect(intents).toEqual([]);
  });

  it("does not open when bandwidth is below the minimum", () => {
    const { intents, state } = decide(
      { lastPrice: 100_001, closes: [100_000, 100_000, 100_000] },
      { phase: "FLAT", previousPrice: 99_999 },
    );
    expect(state.phase).toBe("FLAT");
    expect(intents).toEqual([]);
  });

  it("ignores the in-progress candle when computing SMA and bandwidth", () => {
    const { intents } = decide(
      {
        lastPrice: 100_001,
        extraOpenCandle: 1,
      },
      { phase: "FLAT", previousPrice: 99_999 },
    );
    expect(intents.some(isEntryIntent)).toBe(true);
  });

  it("does not open a second time in the same UTC minute", () => {
    const { intents } = decide(
      { lastPrice: 100_001, now: NOW },
      {
        phase: "FLAT",
        previousPrice: 99_999,
        lastEntryAt: Date.UTC(2026, 7, 17, 10, 30, 10),
      },
    );
    expect(intents).toEqual([]);
  });

  it("allows another entry after the UTC minute rolls", () => {
    const { intents } = decide(
      { lastPrice: 100_001, now: Date.UTC(2026, 7, 17, 10, 31, 1) },
      {
        phase: "FLAT",
        previousPrice: 99_999,
        lastEntryAt: Date.UTC(2026, 7, 17, 10, 30, 10),
      },
    );
    expect(intents.some(isEntryIntent)).toBe(true);
  });

  it("blocks entry until TREND_ENTRY_COOLDOWN_MS after a stop", () => {
    const blocked = decide(
      { lastPrice: 100_001, now: NOW },
      {
        phase: "FLAT",
        previousPrice: 99_999,
        lastStopAt: NOW - 1_000,
      },
    );
    expect(blocked.intents).toEqual([]);
    const ready = decide(
      { lastPrice: 100_001, now: NOW },
      {
        phase: "FLAT",
        previousPrice: 99_999,
        lastStopAt: NOW - 60_000,
      },
    );
    expect(ready.intents.some(isEntryIntent)).toBe(true);
  });

  it("does not enter while reconciling, even on a valid cross", () => {
    const { intents } = decide(
      { lastPrice: 100_001, lifecycle: "RECONCILING" },
      { phase: "FLAT", previousPrice: 99_999 },
    );
    expect(intents.some(isEntryIntent)).toBe(false);
  });

  it("does not enter while rate-limit state is not NORMAL", () => {
    const { intents } = decide(
      { lastPrice: 100_001, rateLimitState: "DEGRADED" },
      { phase: "FLAT", previousPrice: 99_999 },
    );
    expect(intents.some(isEntryIntent)).toBe(false);
  });

  it("does not enter when a leftover instance entry order is live", () => {
    const leftover = testOrder(ownership, {
      purpose: "entry",
      sequence: 1,
      side: "BUY",
      type: "MARKET",
      reduceOnly: false,
    });
    const { intents } = decide(
      { lastPrice: 100_001, openOrders: [leftover] },
      { phase: "FLAT", previousPrice: 99_999 },
    );
    expect(intents.some(isEntryIntent)).toBe(false);
    expect(intents).toEqual([
      {
        type: "CANCEL",
        strategyId: "trend",
        orderIds: [leftover.clientOrderId],
      },
    ]);
  });

  it("does not pyramid or reverse-cross flatten while in position", () => {
    const { intents, state } = decide(
      {
        position: longPosition(),
        lastPrice: 99_999,
        markPrice: 100_000,
      },
      { phase: "IN_POSITION", previousPrice: 100_001 },
    );
    expect(state.phase).toBe("IN_POSITION");
    expect(intents.some(isEntryIntent)).toBe(false);
    expect(
      intents.some(
        (intent) => intent.type === "PLACE_MARKET" && intent.reduceOnly === true,
      ),
    ).toBe(false);
    expect(intents.some((intent) => intent.type === "PLACE_STOP")).toBe(true);
    expect(
      intents.some((intent) => intent.type === "PLACE_TRAILING_STOP"),
    ).toBe(true);
  });

  it("places reduce-only stop and trailing after a position exists", () => {
    const { intents } = decide({
      position: longPosition(),
      lastPrice: 100_000,
      markPrice: 100_000,
    });
    expect(intents).toEqual([
      {
        type: "PLACE_STOP",
        strategyId: "trend",
        symbol: "BTCUSDT",
        side: "SELL",
        stopPrice: 98_000,
        quantity: 0.001,
        reduceOnly: true,
      },
      {
        type: "PLACE_TRAILING_STOP",
        strategyId: "trend",
        symbol: "BTCUSDT",
        side: "SELL",
        activationPrice: 103_000,
        callbackRate: 0.2,
        quantity: 0.001,
        reduceOnly: true,
      },
    ]);
  });

  it("emits a reduce-only market close when soft loss exceeds LOSS_LIMIT_USDT", () => {
    const { intents } = decide({
      position: longPosition(),
      lastPrice: 97_000,
      markPrice: 97_000,
    });
    expect(
      intents.some(
        (intent) =>
          intent.type === "PLACE_MARKET" &&
          intent.reduceOnly === true &&
          intent.reason === "soft_loss" &&
          intent.side === "SELL",
      ),
    ).toBe(true);
    expect(intents.some((intent) => intent.type === "PLACE_STOP")).toBe(true);
  });

  it("does not open a second position on restart while already in one", () => {
    const { intents, state } = decide(
      {
        position: longPosition(),
        lastPrice: 100_001,
        markPrice: 100_000,
        lifecycle: "RECONCILING",
      },
      { phase: "FLAT", previousPrice: 99_999 },
    );
    expect(state.phase).toBe("PROTECTING");
    expect(intents.some(isEntryIntent)).toBe(false);
    expect(intents.some((intent) => intent.type === "PLACE_STOP")).toBe(true);
  });

  it("records lastStopAt when a protected position goes flat", () => {
    const { state, intents } = decide(
      { position: null, lastPrice: 100_001 },
      { phase: "IN_POSITION", previousPrice: 99_999 },
    );
    expect(state.lastStopAt).toBe(NOW);
    expect(state.phase).toBe("FLAT");
    expect(intents.some(isEntryIntent)).toBe(false);
  });
});

describe("Trend open / protect / close cycle", () => {
  it("opens once, protects, then reduce-only closes on soft loss", async () => {
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(),
    });
    const execution = new ExecutionService(venue, ownership);
    const pipeline = new IntentPipeline(
      execution,
      new RateLimitMachine({
        cleanWindowMs: 1_000,
        pausedCooldownMs: 1_000,
        repeated429WhileDegraded: 1,
      }),
    );

    const opened = decide(
      { lastPrice: 100_001 },
      { phase: "FLAT", previousPrice: 99_999 },
    );
    const first = await pipeline.run(
      opened.intents,
      testRiskContext(ownership, {
        markPrice: 100_001,
        closeCandidatePrice: 100_001,
      }),
    );
    expect(first.execution?.placed[0]?.reduceOnly).toBe(false);
    const position = venue.account.positions[0];
    expect(position?.quantity).toBe(0.001);

    const protectedTick = evaluateTrend({
      snapshot: snapshot({
        position: position ?? longPosition(),
        lastPrice: 100_000,
        markPrice: 100_000,
        openOrders: await venue.fetchOpenOrders("BTCUSDT"),
      }),
      config: trendConfig,
      ownership,
      state: opened.state,
    });
    expect(protectedTick.intents.some(isEntryIntent)).toBe(false);
    const second = await pipeline.run(
      protectedTick.intents,
      testRiskContext(ownership, {
        position: position ?? longPosition(),
        account: testAccount(position ?? longPosition()),
        markPrice: 100_000,
        openOrders: await venue.fetchOpenOrders("BTCUSDT"),
      }),
    );
    expect(
      second.execution?.placed.some((order) => order.type === "STOP_MARKET"),
    ).toBe(true);
    expect(
      second.execution?.placed.every((order) => order.reduceOnly),
    ).toBe(true);

    const soft = evaluateTrend({
      snapshot: snapshot({
        position: position ?? longPosition(),
        lastPrice: 97_000,
        markPrice: 97_000,
        openOrders: await venue.fetchOpenOrders("BTCUSDT"),
      }),
      config: trendConfig,
      ownership,
      state: protectedTick.state,
    });
    const close = soft.intents.find(
      (intent) => intent.type === "PLACE_MARKET" && intent.reduceOnly,
    );
    expect(close).toMatchObject({ side: "SELL", reason: "soft_loss" });
    await pipeline.run(
      soft.intents.filter(
        (intent) => intent.type === "PLACE_MARKET" && intent.reduceOnly,
      ),
      testRiskContext(ownership, {
        position: position ?? longPosition(),
        account: testAccount(position ?? longPosition()),
        markPrice: 97_000,
        closeCandidatePrice: 97_000,
        openOrders: await venue.fetchOpenOrders("BTCUSDT"),
      }),
    );
    expect(venue.account.positions[0]?.quantity).toBe(0);

    const afterStop = evaluateTrend({
      snapshot: snapshot({ lastPrice: 100_001 }),
      config: trendConfig,
      ownership,
      state: { ...soft.state, phase: "IN_POSITION" },
    });
    expect(afterStop.state.lastStopAt).toBe(NOW);
    expect(afterStop.intents.some(isEntryIntent)).toBe(false);
  });

  it("starts from the initial empty state", () => {
    expect(initialTrendState()).toEqual({ phase: "FLAT" });
  });
});
