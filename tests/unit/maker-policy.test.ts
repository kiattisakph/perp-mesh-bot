import { describe, expect, it } from "vitest";
import { isEntryIntent } from "../../src/domain/intent";
import type { OrderBook } from "../../src/domain/market";
import type { FuturesPosition } from "../../src/domain/account";
import type { StrategySnapshot } from "../../src/domain/strategy";
import {
  classicDesiredQuotes,
  evaluateMaker,
  liquidityDesiredQuotes,
  liquidityExitPrice,
  offsetDesiredQuotes,
  skipEntrySides,
  shouldForcedFlatten,
  type MakerConfig,
} from "../../src/strategies/maker";
import {
  btcPrecision,
  foreignOrder,
  longPosition,
  testAccount,
  testOrder,
  testOwnership,
} from "../helpers/trading-fixtures";

const NOW = 10_000;
const ownership = testOwnership("maker", "a1");

function makerConfig(
  variant: MakerConfig["variant"],
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
    skipRatio: variant === "liquidity" ? 2 : 3,
    forcedExitRatio: 6,
    closeTickOffset: 1,
    recentFillMs: 60_000,
    ...overrides,
  };
}

function shortPosition(
  quantity = -0.001,
  entryPrice = 100_000,
): FuturesPosition {
  return {
    ...longPosition(Math.abs(quantity), entryPrice),
    quantity,
  };
}

function stackedBook(input: {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  eventTime?: number;
}): OrderBook {
  const bids = [];
  const asks = [];
  for (let i = 0; i < 10; i++) {
    bids.push({
      price: input.bid - i * 0.1,
      quantity: input.bidQty,
    });
    asks.push({
      price: input.ask + i * 0.1,
      quantity: input.askQty,
    });
  }
  return {
    symbol: "BTCUSDT",
    bids,
    asks,
    eventTime: input.eventTime ?? NOW,
    sequence: 1,
  };
}

function balancedBook(eventTime = NOW): OrderBook {
  return stackedBook({
    bid: 100_000,
    ask: 100_000.2,
    bidQty: 1,
    askQty: 1,
    eventTime,
  });
}

function snapshot(input: {
  strategyId?: string;
  position?: FuturesPosition | null;
  openOrders?: StrategySnapshot["openOrders"];
  book?: OrderBook;
  markPrice?: number;
  lifecycle?: StrategySnapshot["lifecycle"];
  rateLimitState?: StrategySnapshot["rateLimitState"];
  now?: number;
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
    orderBook: input.book ?? balancedBook(),
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

describe("Classic Maker desired quotes", () => {
  const config = makerConfig("classic");

  it("quotes post-only bid and ask when flat", () => {
    const desired = classicDesiredQuotes({
      snapshot: snapshot(),
      config,
      book: balancedBook(),
    });
    expect(desired).toEqual([
      {
        purpose: "ENTRY_BID",
        side: "BUY",
        price: 100_000,
        quantity: 0.001,
        reduceOnly: false,
        postOnly: true,
      },
      {
        purpose: "ENTRY_ASK",
        side: "SELL",
        price: 100_000.2,
        quantity: 0.001,
        reduceOnly: false,
        postOnly: true,
      },
    ]);
  });

  it("leaves only a reduce-only L1 exit after a fill", () => {
    const desired = classicDesiredQuotes({
      snapshot: snapshot({ position: longPosition() }),
      config,
      book: balancedBook(),
    });
    expect(desired).toEqual([
      {
        purpose: "EXIT",
        side: "SELL",
        price: 100_000,
        quantity: 0.001,
        reduceOnly: true,
        postOnly: false,
      },
    ]);
    expect(desired.every((quote) => quote.reduceOnly)).toBe(true);
  });

  it("does not emit entry quotes while in position", () => {
    const longQuotes = classicDesiredQuotes({
      snapshot: snapshot({ position: longPosition() }),
      config,
      book: balancedBook(),
    });
    const shortQuotes = classicDesiredQuotes({
      snapshot: snapshot({ position: shortPosition() }),
      config,
      book: balancedBook(),
    });
    expect(longQuotes.some((quote) => quote.purpose.startsWith("ENTRY"))).toBe(
      false,
    );
    expect(shortQuotes).toEqual([
      {
        purpose: "EXIT",
        side: "BUY",
        price: 100_000.2,
        quantity: 0.001,
        reduceOnly: true,
        postOnly: false,
      },
    ]);
  });
});

describe("Offset Maker imbalance", () => {
  const config = makerConfig("offset");

  it("quotes both sides on a balanced book", () => {
    const { desired, flatten } = offsetDesiredQuotes({
      snapshot: snapshot({ strategyId: "offset-maker" }),
      config,
      book: balancedBook(),
    });
    expect(flatten).toBe(false);
    expect(desired.map((quote) => quote.purpose)).toEqual([
      "ENTRY_BID",
      "ENTRY_ASK",
    ]);
    const buy = desired.find((quote) => quote.side === "BUY");
    const sell = desired.find((quote) => quote.side === "SELL");
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    expect(buy!.price).toBeLessThan(100_000.2);
    expect(sell!.price).toBeGreaterThan(100_000);
  });

  it("skips SELL entry when the ask is thin", () => {
    expect(skipEntrySides(10, 1, 3)).toEqual({ skipBuy: false, skipSell: true });
    const { desired } = offsetDesiredQuotes({
      snapshot: snapshot({ strategyId: "offset-maker" }),
      config,
      book: stackedBook({
        bid: 100_000,
        ask: 100_000.2,
        bidQty: 10,
        askQty: 1,
      }),
    });
    expect(desired.map((quote) => quote.purpose)).toEqual(["ENTRY_BID"]);
  });

  it("skips BUY entry when the bid is thin", () => {
    expect(skipEntrySides(1, 10, 3)).toEqual({ skipBuy: true, skipSell: false });
    const { desired } = offsetDesiredQuotes({
      snapshot: snapshot({ strategyId: "offset-maker" }),
      config,
      book: stackedBook({
        bid: 100_000,
        ask: 100_000.2,
        bidQty: 1,
        askQty: 10,
      }),
    });
    expect(desired.map((quote) => quote.purpose)).toEqual(["ENTRY_ASK"]);
  });

  it("flattens with a reduce-only market when imbalance is against the position", () => {
    const againstLong = stackedBook({
      bid: 100_000,
      ask: 100_000.2,
      bidQty: 1,
      askQty: 10,
    });
    expect(
      shouldForcedFlatten({
        quantity: 0.001,
        bidDepth: 10,
        askDepth: 100,
        forcedExitRatio: 6,
      }),
    ).toBe(true);
    const { flatten, desired } = offsetDesiredQuotes({
      snapshot: snapshot({
        strategyId: "offset-maker",
        position: longPosition(),
        book: againstLong,
      }),
      config,
      book: againstLong,
    });
    expect(flatten).toBe(true);
    expect(desired).toEqual([]);

    const result = evaluateMaker({
      snapshot: snapshot({
        strategyId: "offset-maker",
        position: longPosition(),
        book: againstLong,
        markPrice: 100_000,
      }),
      config,
      ownership: testOwnership("offset-maker", "a1"),
    });
    expect(result.intents.some((intent) => intent.type === "PLACE_MARKET")).toBe(
      true,
    );
    const close = result.intents.find((intent) => intent.type === "PLACE_MARKET");
    expect(close).toMatchObject({
      type: "PLACE_MARKET",
      side: "SELL",
      reduceOnly: true,
      reason: "offset_imbalance_flatten",
    });
    expect(result.intents.some(isEntryIntent)).toBe(false);
  });

  it("does not cross the spread after the maker clamp", () => {
    const { desired } = offsetDesiredQuotes({
      snapshot: snapshot({ strategyId: "offset-maker" }),
      config,
      book: balancedBook(),
    });
    for (const quote of desired) {
      if (quote.side === "BUY") {
        expect(quote.price).toBeLessThan(100_000.2);
      } else {
        expect(quote.price).toBeGreaterThan(100_000);
      }
    }
  });
});

describe("Liquidity Maker exit pricing", () => {
  const config = makerConfig("liquidity");

  it("prefers a recent fill over position entry price", () => {
    const book = balancedBook();
    const fromFill = liquidityDesiredQuotes({
      snapshot: snapshot({
        strategyId: "liquidity-maker",
        position: longPosition(0.001, 100_000),
        book,
      }),
      config,
      book,
      recentFill: { price: 100_001, eventTime: NOW, accumulatedFilledQuantity: 0.001 },
      now: NOW,
    });
    const fromEntry = liquidityDesiredQuotes({
      snapshot: snapshot({
        strategyId: "liquidity-maker",
        position: longPosition(0.001, 100_000),
        book,
      }),
      config,
      book,
      recentFill: undefined,
      now: NOW,
    });
    expect(fromFill[0]?.price).toBeGreaterThan(fromEntry[0]?.price ?? 0);
    expect(fromFill[0]).toMatchObject({
      purpose: "EXIT",
      side: "SELL",
      reduceOnly: true,
      postOnly: false,
    });
  });

  it("does not place a long exit below the breakeven target when the book allows", () => {
    const book = balancedBook();
    const price = liquidityExitPrice({
      book,
      quantity: 0.001,
      entryPrice: 100_000,
      fillOrEntry: 100_000,
      closeTickOffset: 1,
      precision: btcPrecision,
    });
    expect(price).toBe(100_000.1);
    expect(price).toBeGreaterThanOrEqual(100_000 + 0.1);
  });

  it("does not place a short exit above the breakeven target when the book allows", () => {
    const book = balancedBook();
    const price = liquidityExitPrice({
      book,
      quantity: -0.001,
      entryPrice: 100_000,
      fillOrEntry: 100_000,
      closeTickOffset: 1,
      precision: btcPrecision,
    });
    expect(price).toBe(99_999.9);
    expect(price).toBeLessThanOrEqual(100_000 - 0.1);
  });

  it("does not forced-exit from depth imbalance", () => {
    const againstLong = stackedBook({
      bid: 100_000,
      ask: 100_000.2,
      bidQty: 1,
      askQty: 10,
    });
    const desired = liquidityDesiredQuotes({
      snapshot: snapshot({
        strategyId: "liquidity-maker",
        position: longPosition(),
        book: againstLong,
      }),
      config,
      book: againstLong,
      recentFill: undefined,
      now: NOW,
    });
    expect(desired[0]).toMatchObject({
      purpose: "EXIT",
      reduceOnly: true,
    });
    const result = evaluateMaker({
      snapshot: snapshot({
        strategyId: "liquidity-maker",
        position: longPosition(),
        book: againstLong,
        markPrice: 100_000,
      }),
      config,
      ownership: testOwnership("liquidity-maker", "a1"),
    });
    expect(result.intents.some((intent) => intent.type === "PLACE_MARKET")).toBe(
      false,
    );
    const place = result.intents.find((intent) => intent.type === "PLACE_LIMIT");
    expect(place).toMatchObject({ reduceOnly: true, side: "SELL" });
  });
});

describe("Classic Maker engine intents", () => {
  const config = makerConfig("classic");

  it("does not duplicate quotes that already match", () => {
    const open = [
      testOrder(ownership, {
        purpose: "bid",
        sequence: 1,
        side: "BUY",
        reduceOnly: false,
        price: 100_000,
        quantity: 0.001,
      }),
      testOrder(ownership, {
        purpose: "ask",
        sequence: 2,
        side: "SELL",
        reduceOnly: false,
        price: 100_000.2,
        quantity: 0.001,
      }),
    ];
    const result = evaluateMaker({
      snapshot: snapshot({ openOrders: open }),
      config,
      ownership,
    });
    expect(result.intents).toEqual([]);
    expect(result.state.phase).toBe("FLAT_QUOTING");
  });

  it("cancels owned quotes before a reduce-only market close on USD loss", () => {
    const bid = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100_000,
    });
    const ask = testOrder(ownership, {
      purpose: "ask",
      sequence: 2,
      side: "SELL",
      reduceOnly: false,
      price: 100_000.2,
    });
    const foreign = foreignOrder();
    const crashed = stackedBook({
      bid: 97_000,
      ask: 97_000.2,
      bidQty: 1,
      askQty: 1,
    });
    const result = evaluateMaker({
      snapshot: snapshot({
        position: longPosition(0.001, 100_000),
        openOrders: [bid, ask, foreign],
        book: crashed,
        markPrice: 97_000,
      }),
      config,
      ownership,
    });
    expect(result.intents[0]).toEqual({
      type: "CANCEL",
      strategyId: "maker",
      orderIds: [bid.clientOrderId, ask.clientOrderId],
    });
    expect(result.intents[1]).toMatchObject({
      type: "PLACE_MARKET",
      reduceOnly: true,
      side: "SELL",
      reason: "maker_loss_limit",
    });
    expect(
      result.intents.some(
        (intent) =>
          intent.type === "CANCEL" &&
          intent.orderIds.includes(foreign.clientOrderId),
      ),
    ).toBe(false);
  });

  it("does not increase position size while already in position", () => {
    const result = evaluateMaker({
      snapshot: snapshot({ position: longPosition() }),
      config,
      ownership,
    });
    expect(result.intents.some(isEntryIntent)).toBe(false);
    expect(result.state.phase).toBe("POSITION_EXIT_ONLY");
    for (const intent of result.intents) {
      if (intent.type === "PLACE_LIMIT" || intent.type === "PLACE_MARKET") {
        expect(intent.reduceOnly).toBe(true);
      }
    }
  });
});
