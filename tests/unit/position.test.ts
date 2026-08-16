import { describe, expect, it } from "vitest";
import { remainingQuantity } from "../../src/domain/order";
import {
  absQuantity,
  closeSide,
  entrySide,
  isFlat,
  isLong,
  isShort,
  positionDirection,
} from "../../src/domain/position";
import type { TradingOrder } from "../../src/domain/order";

describe("signed position helpers", () => {
  it("treats positive quantity as long, negative as short, and zero as flat", () => {
    expect(isLong(0.002)).toBe(true);
    expect(isShort(0.002)).toBe(false);
    expect(isFlat(0.002)).toBe(false);
    expect(positionDirection(0.002)).toBe("long");

    expect(isShort(-0.001)).toBe(true);
    expect(isLong(-0.001)).toBe(false);
    expect(isFlat(-0.001)).toBe(false);
    expect(positionDirection(-0.001)).toBe("short");

    expect(isFlat(0)).toBe(true);
    expect(isLong(0)).toBe(false);
    expect(isShort(0)).toBe(false);
    expect(positionDirection(0)).toBe("flat");
  });

  it("returns absolute position quantity", () => {
    expect(absQuantity(-0.003)).toBe(0.003);
    expect(absQuantity(0.003)).toBe(0.003);
    expect(absQuantity(0)).toBe(0);
  });

  it("maps close and entry sides for one-way mode", () => {
    expect(closeSide(0.01)).toBe("SELL");
    expect(closeSide(-0.01)).toBe("BUY");
    expect(entrySide("long")).toBe("BUY");
    expect(entrySide("short")).toBe("SELL");
  });

  it("refuses a close side when flat", () => {
    expect(() => closeSide(0)).toThrow(/flat/);
  });

  it("computes remaining order quantity as quantity minus filledQuantity", () => {
    const order: TradingOrder = {
      exchangeOrderId: "1",
      clientOrderId: "bfu-trend-a1-entry-000001",
      strategyId: "trend",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      status: "PARTIALLY_FILLED",
      quantity: 0.002,
      filledQuantity: 0.001,
      reduceOnly: false,
      updateTime: 0,
    };
    expect(remainingQuantity(order)).toBe(0.001);
  });
});
