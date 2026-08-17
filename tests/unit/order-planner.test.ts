import { describe, expect, it } from "vitest";
import type { DesiredQuote } from "../../src/application/order-planner";
import { planQuoteIntents } from "../../src/application/order-planner";
import {
  foreignOrder,
  testOrder,
  testOwnership,
} from "../helpers/trading-fixtures";

const bid: DesiredQuote = {
  purpose: "ENTRY_BID",
  side: "BUY",
  price: 100,
  quantity: 0.001,
  reduceOnly: false,
  postOnly: true,
};

const ask: DesiredQuote = {
  purpose: "ENTRY_ASK",
  side: "SELL",
  price: 101,
  quantity: 0.001,
  reduceOnly: false,
  postOnly: true,
};

describe("order planner", () => {
  const ownership = testOwnership("maker", "a1");

  it("emits nothing on an exact owned match", () => {
    const open = [
      testOrder(ownership, {
        purpose: "bid",
        sequence: 1,
        side: "BUY",
        reduceOnly: false,
        price: 100,
        quantity: 0.001,
      }),
    ];
    expect(
      planQuoteIntents({
        desired: [bid],
        openOrders: open,
        ownership,
        strategyId: "maker",
        symbol: "BTCUSDT",
      }),
    ).toEqual([]);
  });

  it("replaces an owned order on price drift", () => {
    const open = [
      testOrder(ownership, {
        purpose: "bid",
        sequence: 1,
        side: "BUY",
        reduceOnly: false,
        price: 99,
        quantity: 0.001,
      }),
    ];
    const intents = planQuoteIntents({
      desired: [bid],
      openOrders: open,
      ownership,
      strategyId: "maker",
      symbol: "BTCUSDT",
    });
    expect(intents[0]).toMatchObject({
      type: "CANCEL",
      orderIds: [open[0].clientOrderId],
    });
    expect(intents[1]).toMatchObject({
      type: "PLACE_LIMIT",
      price: 100,
      reduceOnly: false,
    });
  });

  it("replaces an owned order on quantity drift", () => {
    const open = [
      testOrder(ownership, {
        purpose: "bid",
        sequence: 1,
        side: "BUY",
        reduceOnly: false,
        price: 100,
        quantity: 0.002,
      }),
    ];
    const intents = planQuoteIntents({
      desired: [bid],
      openOrders: open,
      ownership,
      strategyId: "maker",
      symbol: "BTCUSDT",
    });
    expect(intents[0]?.type).toBe("CANCEL");
    expect(intents[1]).toMatchObject({
      type: "PLACE_LIMIT",
      quantity: 0.001,
    });
  });

  it("replaces on a reduce-only mismatch", () => {
    const open = [
      testOrder(ownership, {
        purpose: "exit",
        sequence: 1,
        side: "SELL",
        reduceOnly: false,
        price: 101,
        quantity: 0.001,
      }),
    ];
    const exit: DesiredQuote = {
      purpose: "EXIT",
      side: "SELL",
      price: 101,
      quantity: 0.001,
      reduceOnly: true,
      postOnly: false,
    };
    const intents = planQuoteIntents({
      desired: [exit],
      openOrders: open,
      ownership,
      strategyId: "maker",
      symbol: "BTCUSDT",
    });
    expect(intents[0]?.type).toBe("CANCEL");
    expect(intents[1]).toMatchObject({
      type: "PLACE_LIMIT",
      reduceOnly: true,
    });
  });

  it("does not cancel a foreign order on ownership mismatch", () => {
    const foreign = foreignOrder();
    const intents = planQuoteIntents({
      desired: [bid],
      openOrders: [foreign],
      ownership,
      strategyId: "maker",
      symbol: "BTCUSDT",
    });
    expect(intents.some((intent) => intent.type === "CANCEL")).toBe(false);
    expect(intents).toMatchObject([
      { type: "PLACE_LIMIT", side: "BUY", price: 100 },
    ]);
  });

  it("does not emit a duplicate place for the same purpose", () => {
    const intents = planQuoteIntents({
      desired: [bid, { ...bid, price: 99.9 }],
      openOrders: [],
      ownership,
      strategyId: "maker",
      symbol: "BTCUSDT",
    });
    const places = intents.filter((intent) => intent.type === "PLACE_LIMIT");
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ price: 100 });
  });

  it("cancels unexpected owned quotes that are not desired", () => {
    const extra = testOrder(ownership, {
      purpose: "ask",
      sequence: 2,
      side: "SELL",
      reduceOnly: false,
      price: 101,
    });
    const matching = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100,
    });
    const intents = planQuoteIntents({
      desired: [bid],
      openOrders: [matching, extra],
      ownership,
      strategyId: "maker",
      symbol: "BTCUSDT",
    });
    expect(intents).toEqual([
      {
        type: "CANCEL",
        strategyId: "maker",
        orderIds: [extra.clientOrderId],
      },
    ]);
    expect(intents[0]).not.toMatchObject({ orderIds: [matching.clientOrderId] });
  });

  it("can plan both sides when none exist", () => {
    const intents = planQuoteIntents({
      desired: [bid, ask],
      openOrders: [],
      ownership,
      strategyId: "maker",
      symbol: "BTCUSDT",
    });
    expect(intents).toHaveLength(2);
  });
});
