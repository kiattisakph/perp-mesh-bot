import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isEntryIntent } from "../../src/domain/intent";
import type { Candle } from "../../src/domain/market";
import type { FuturesPosition } from "../../src/domain/account";
import type { StrategySnapshot } from "../../src/domain/strategy";
import { rsiFromClosedCloses } from "../../src/indicators/rsi";
import {
  ExecutionService,
  IntentPipeline,
} from "../../src/application";
import { RateLimitMachine } from "../../src/risk/rate-limit";
import {
  evaluateSwing,
  initialSwingState,
  loadSwingState,
  saveSwingState,
  swingStateFilePath,
  type SwingConfig,
  type SwingState,
} from "../../src/strategies/swing";
import { FakeVenue } from "../helpers/fake-venue";
import {
  btcPrecision,
  longPosition,
  testAccount,
  testOrder,
  testOwnership,
  testRiskContext,
} from "../helpers/trading-fixtures";

const ownership = testOwnership("swing", "a1");

const swingConfig: SwingConfig = {
  tradeQuantity: 0.001,
  direction: "both",
  rsiPeriod: 14,
  rsiHigh: 70,
  rsiLow: 30,
  stopLossFraction: 0.05,
  requireProfitForExit: true,
};

const NOW = Date.UTC(2026, 7, 17, 10, 30, 45);

function shortPosition(
  quantity = -0.001,
  entryPrice = 100_000,
): FuturesPosition {
  return {
    ...longPosition(Math.abs(quantity), entryPrice),
    quantity,
  };
}

function closesEndingAtRsi(target: number, period = 14): number[] {
  const seed: number[] = [];
  for (let i = 0; i < period + 5; i++) {
    seed.push(100);
  }
  for (let i = 0; i < 20; i++) {
    seed.push(100 - i);
  }
  for (let i = 0; i < 10; i++) {
    seed.push(80 + i);
  }
  let lo = 1;
  let hi = 200;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const value = rsiFromClosedCloses([...seed, mid], period);
    if (value === null) {
      throw new Error("RSI not stable");
    }
    if (value < target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return [...seed, (lo + hi) / 2];
}

function closedCandles(closes: readonly number[]): Candle[] {
  return closes.map((close, index) => ({
    symbol: "BTCUSDT",
    interval: "4h",
    openTime: index * 14_400_000,
    closeTime: (index + 1) * 14_400_000 - 1,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    closed: true,
  }));
}

function snapshot(input: {
  position?: FuturesPosition | null;
  openOrders?: StrategySnapshot["openOrders"];
  markPrice?: number;
  closes?: readonly number[];
  extraOpenCandle?: number;
  lifecycle?: StrategySnapshot["lifecycle"];
  rateLimitState?: StrategySnapshot["rateLimitState"];
  now?: number;
} = {}): StrategySnapshot {
  const mark = input.markPrice ?? 100_000;
  const candles = closedCandles(input.closes ?? closesEndingAtRsi(50));
  if (input.extraOpenCandle !== undefined) {
    candles.push({
      symbol: "BTCUSDT",
      interval: "4h",
      openTime: candles.length * 14_400_000,
      closeTime: (candles.length + 1) * 14_400_000 - 1,
      open: input.extraOpenCandle,
      high: input.extraOpenCandle,
      low: input.extraOpenCandle,
      close: input.extraOpenCandle,
      volume: 1,
      closed: false,
    });
  }
  const position = input.position === undefined ? null : input.position;
  return {
    strategyId: "swing",
    instanceId: "a1",
    symbol: "BTCUSDT",
    lifecycle: input.lifecycle ?? "READY",
    rateLimitState: input.rateLimitState ?? "NORMAL",
    account: testAccount(position),
    position,
    openOrders: input.openOrders ?? [],
    ticker: {
      symbol: "BTCUSDT",
      lastPrice: mark,
      markPrice: mark,
      eventTime: NOW,
    },
    markPrice: mark,
    candles,
    precision: btcPrecision,
    now: input.now ?? NOW,
  };
}

function decide(
  input: Parameters<typeof snapshot>[0] = {},
  state?: SwingState,
  config: SwingConfig = swingConfig,
): ReturnType<typeof evaluateSwing> {
  return evaluateSwing({
    snapshot: snapshot(input),
    config,
    ownership,
    state,
  });
}

function unarmed(previousRsi: number): SwingState {
  return { ...initialSwingState(), previousRsi };
}

describe("Swing arm/cross", () => {
  it("RSI 69→71 arms short; 71→69 opens short", () => {
    const armed = decide(
      { closes: closesEndingAtRsi(71) },
      unarmed(69),
    );
    expect(armed.state.armedShortEntry).toBe(true);
    expect(armed.intents.some(isEntryIntent)).toBe(false);

    const opened = decide(
      { closes: closesEndingAtRsi(69) },
      armed.state,
    );
    expect(opened.intents).toEqual([
      {
        type: "PLACE_MARKET",
        strategyId: "swing",
        symbol: "BTCUSDT",
        side: "SELL",
        quantity: 0.001,
        reduceOnly: false,
        reason: "swing_entry",
      },
    ]);
  });

  it("RSI 31→29 arms long; 29→31 opens long", () => {
    const armed = decide(
      { closes: closesEndingAtRsi(29) },
      unarmed(31),
    );
    expect(armed.state.armedLongEntry).toBe(true);
    expect(armed.intents.some(isEntryIntent)).toBe(false);

    const opened = decide(
      { closes: closesEndingAtRsi(31) },
      armed.state,
    );
    expect(opened.intents[0]).toMatchObject({
      type: "PLACE_MARKET",
      side: "BUY",
      reduceOnly: false,
      reason: "swing_entry",
    });
  });

  it("direction filter blocks a disallowed side", () => {
    const { intents, state } = decide(
      { closes: closesEndingAtRsi(71) },
      unarmed(69),
      { ...swingConfig, direction: "long" },
    );
    expect(state.armedShortEntry).toBe(false);
    expect(intents.some(isEntryIntent)).toBe(false);

    const blocked = decide(
      { closes: closesEndingAtRsi(69) },
      { ...unarmed(71), armedShortEntry: true },
      { ...swingConfig, direction: "long" },
    );
    expect(blocked.intents.some(isEntryIntent)).toBe(false);
  });

  it("does not pyramid while a position is open", () => {
    const { intents, state } = decide(
      {
        position: shortPosition(),
        closes: closesEndingAtRsi(69),
        markPrice: 100_000,
      },
      { ...unarmed(71), armedShortEntry: true },
    );
    expect(state.armedShortEntry).toBe(false);
    expect(intents.some(isEntryIntent)).toBe(false);
    expect(intents.some((intent) => intent.type === "PLACE_STOP")).toBe(true);
  });

  it("ignores the in-progress USDT-M candle when computing RSI", () => {
    const armed = decide(
      { closes: closesEndingAtRsi(71), extraOpenCandle: 1 },
      unarmed(69),
    );
    expect(armed.state.armedShortEntry).toBe(true);
  });

  it("does not enter while reconciling or rate-limited", () => {
    const armed = { ...unarmed(71), armedShortEntry: true };
    expect(
      decide(
        { closes: closesEndingAtRsi(69), lifecycle: "RECONCILING" },
        armed,
      ).intents.some(isEntryIntent),
    ).toBe(false);
    expect(
      decide(
        { closes: closesEndingAtRsi(69), rateLimitState: "DEGRADED" },
        armed,
      ).intents.some(isEntryIntent),
    ).toBe(false);
  });

  it("does not enter when a leftover instance entry order is live", () => {
    const leftover = testOrder(ownership, {
      purpose: "entry",
      sequence: 1,
      side: "SELL",
      type: "MARKET",
      reduceOnly: false,
    });
    const { intents } = decide(
      { closes: closesEndingAtRsi(69), openOrders: [leftover] },
      { ...unarmed(71), armedShortEntry: true },
    );
    expect(intents.some(isEntryIntent)).toBe(false);
    expect(intents).toEqual([]);
  });
});

describe("Swing signal exit and percent stop", () => {
  it("signal exit waits for mark profit when SWING_REQUIRE_PROFIT_FOR_EXIT is true", () => {
    const armedExit = {
      ...unarmed(29),
      armedShortExit: true,
    };
    const waiting = decide(
      {
        position: shortPosition(),
        closes: closesEndingAtRsi(31),
        markPrice: 100_000,
      },
      armedExit,
    );
    expect(
      waiting.intents.some(
        (intent) => intent.type === "PLACE_MARKET" && intent.reduceOnly,
      ),
    ).toBe(false);

    const profitable = decide(
      {
        position: shortPosition(),
        closes: closesEndingAtRsi(31),
        markPrice: 99_000,
      },
      armedExit,
    );
    expect(
      profitable.intents.some(
        (intent) =>
          intent.type === "PLACE_MARKET" &&
          intent.reduceOnly === true &&
          intent.reason === "swing_signal_exit",
      ),
    ).toBe(true);
  });

  it("signal exit closes without profit when the profit config is false", () => {
    const { intents } = decide(
      {
        position: longPosition(),
        closes: closesEndingAtRsi(69),
        markPrice: 99_000,
      },
      { ...unarmed(71), armedLongExit: true },
      { ...swingConfig, requireProfitForExit: false },
    );
    expect(
      intents.some(
        (intent) =>
          intent.type === "PLACE_MARKET" &&
          intent.reduceOnly === true &&
          intent.reason === "swing_signal_exit",
      ),
    ).toBe(true);
  });

  it("stop breach closes reduce-only without waiting for RSI", () => {
    const { intents } = decide(
      {
        position: longPosition(),
        closes: closesEndingAtRsi(50),
        markPrice: 94_000,
      },
      unarmed(50),
    );
    expect(
      intents.some(
        (intent) =>
          intent.type === "PLACE_MARKET" &&
          intent.reduceOnly === true &&
          intent.reason === "swing_stop" &&
          intent.side === "SELL",
      ),
    ).toBe(true);
    expect(
      intents.some(
        (intent) =>
          intent.type === "PLACE_MARKET" &&
          intent.reason === "swing_signal_exit",
      ),
    ).toBe(false);
    expect(intents.some((intent) => intent.type === "PLACE_STOP")).toBe(true);
  });

  it("places a reduce-only percent STOP_MARKET from entry", () => {
    const { intents } = decide({
      position: longPosition(),
      closes: closesEndingAtRsi(50),
      markPrice: 100_000,
    });
    expect(intents).toContainEqual({
      type: "PLACE_STOP",
      strategyId: "swing",
      symbol: "BTCUSDT",
      side: "SELL",
      stopPrice: 95_000,
      quantity: 0.001,
      reduceOnly: true,
    });
    expect(intents.some((intent) => intent.type === "PLACE_TRAILING_STOP")).toBe(
      false,
    );
  });
});

describe("Swing restart restores armed state", () => {
  it("loads persisted arms and still opens on the completing cross", () => {
    const dir = mkdtempSync(join(tmpdir(), "swing-restart-"));
    const path = swingStateFilePath("a1", dir);
    const armed = decide(
      { closes: closesEndingAtRsi(71) },
      unarmed(69),
    );
    saveSwingState(path, armed.state);
    const restored = loadSwingState(path);
    expect(restored.armedShortEntry).toBe(true);

    const opened = decide(
      { closes: closesEndingAtRsi(69) },
      restored,
    );
    expect(opened.intents.some(isEntryIntent)).toBe(true);
    expect(opened.intents[0]).toMatchObject({ side: "SELL", reason: "swing_entry" });
  });
});

describe("Swing open / protect / close cycle", () => {
  it("opens once, protects with a percent stop, then reduce-only closes on breach", async () => {
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
      { closes: closesEndingAtRsi(69) },
      { ...unarmed(71), armedShortEntry: true },
    );
    const first = await pipeline.run(
      opened.intents,
      testRiskContext(ownership, {
        markPrice: 100_000,
        closeCandidatePrice: 100_000,
      }),
    );
    expect(first.execution?.placed[0]?.reduceOnly).toBe(false);
    const position = venue.account.positions[0];
    expect(position?.quantity).toBe(-0.001);

    const protectedTick = evaluateSwing({
      snapshot: snapshot({
        position: position ?? shortPosition(),
        markPrice: 100_000,
        openOrders: await venue.fetchOpenOrders("BTCUSDT"),
      }),
      config: swingConfig,
      ownership,
      state: opened.state,
    });
    expect(protectedTick.intents.some(isEntryIntent)).toBe(false);
    const second = await pipeline.run(
      protectedTick.intents,
      testRiskContext(ownership, {
        position: position ?? shortPosition(),
        account: testAccount(position ?? shortPosition()),
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

    const breach = evaluateSwing({
      snapshot: snapshot({
        position: position ?? shortPosition(),
        markPrice: 106_000,
        openOrders: await venue.fetchOpenOrders("BTCUSDT"),
      }),
      config: swingConfig,
      ownership,
      state: protectedTick.state,
    });
    const close = breach.intents.find(
      (intent) => intent.type === "PLACE_MARKET" && intent.reduceOnly,
    );
    expect(close).toMatchObject({ side: "BUY", reason: "swing_stop" });
    await pipeline.run(
      breach.intents.filter(
        (intent) => intent.type === "PLACE_MARKET" && intent.reduceOnly,
      ),
      testRiskContext(ownership, {
        position: position ?? shortPosition(),
        account: testAccount(position ?? shortPosition()),
        markPrice: 106_000,
        closeCandidatePrice: 106_000,
        openOrders: await venue.fetchOpenOrders("BTCUSDT"),
      }),
    );
    expect(venue.account.positions[0]?.quantity).toBe(0);
  });

  it("starts from the initial unarmed state", () => {
    expect(initialSwingState()).toEqual({
      previousRsi: null,
      armedShortEntry: false,
      armedShortExit: false,
      armedLongEntry: false,
      armedLongExit: false,
    });
  });
});
