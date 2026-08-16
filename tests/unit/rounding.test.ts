import { describe, expect, it } from "vitest";
import {
  isSendableQuantity,
  roundCloseQuantity,
  roundDownToStep,
  roundEntryQuantity,
  roundMakerPrice,
  roundToTick,
} from "../../src/domain/rounding";
import type { SymbolPrecision } from "../../src/domain/strategy";

const btc: SymbolPrecision = {
  tickSize: 0.1,
  stepSize: 0.001,
  minNotional: 100,
  quantityPrecision: 3,
  pricePrecision: 1,
};

describe("rounding", () => {
  it("rounds entry quantity down to LOT_SIZE.stepSize", () => {
    expect(roundEntryQuantity(0.0019, btc)).toBe(0.001);
    expect(roundEntryQuantity(0.001, btc)).toBe(0.001);
    expect(roundEntryQuantity(0.0025, btc)).toBe(0.002);
  });

  it("returns zero when entry rounds down below one step", () => {
    expect(roundEntryQuantity(0.0009, btc)).toBe(0);
    expect(isSendableQuantity(roundEntryQuantity(0.0009, btc))).toBe(false);
  });

  it("never increases close quantity past absolute position after step rounding", () => {
    expect(roundCloseQuantity(0.005, 0.003, btc)).toBe(0.003);
    expect(roundCloseQuantity(0.0035, 0.0035, btc)).toBe(0.003);
    expect(roundCloseQuantity(0.002, 0.002, btc)).toBe(0.002);
  });

  it("uses MARKET_LOT_SIZE when rounding a market close", () => {
    const precision: SymbolPrecision = {
      ...btc,
      marketStepSize: 0.01,
    };
    expect(roundCloseQuantity(0.015, 0.015, precision, "market")).toBe(0.01);
    expect(roundEntryQuantity(0.019, precision, "limit")).toBe(0.019);
    expect(roundEntryQuantity(0.019, precision, "market")).toBe(0.01);
  });

  it("rounds maker BUY down and SELL up to tickSize", () => {
    expect(roundMakerPrice(100.05, "BUY", btc)).toBe(100);
    expect(roundMakerPrice(100.05, "SELL", btc)).toBe(100.1);
    expect(roundMakerPrice(100.1, "BUY", btc)).toBe(100.1);
    expect(roundMakerPrice(100.1, "SELL", btc)).toBe(100.1);
  });

  it("keeps already-aligned prices on the tick", () => {
    expect(roundToTick(100.1, 0.1, "down")).toBe(100.1);
    expect(roundToTick(100.1, 0.1, "up")).toBe(100.1);
  });

  it("rounds decimal increments without floating-point drift", () => {
    expect(roundDownToStep(0.3, 0.1)).toBe(0.3);
    expect(roundToTick(1.15, 0.01, "down")).toBe(1.15);
    expect(roundToTick(1.151, 0.01, "up")).toBe(1.16);
    expect(roundDownToStep(0.00001234, 0.00000001)).toBe(0.00001234);
  });

  it("rejects unknown or non-positive precision", () => {
    expect(() => roundDownToStep(1, 0)).toThrow(/stepSize/);
    expect(() => roundToTick(1, Number.NaN, "down")).toThrow(/tickSize/);
    expect(() => roundEntryQuantity(0, btc)).toThrow(/greater than 0/);
  });
});
