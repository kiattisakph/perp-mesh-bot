import { describe, expect, it } from "vitest";
import { meetsMinNotional, notional } from "../../src/domain/rounding";
import type { SymbolPrecision } from "../../src/domain/strategy";

const precision: SymbolPrecision = {
  tickSize: 0.01,
  stepSize: 0.001,
  minNotional: 5,
  quantityPrecision: 3,
  pricePrecision: 2,
};

describe("min notional", () => {
  it("computes notional as abs(quantity) * price", () => {
    expect(notional(0.001, 4000)).toBe(4);
    expect(notional(-0.002, 4000)).toBe(8);
  });

  it("rejects orders below minNotional from SymbolPrecision", () => {
    expect(meetsMinNotional(0.001, 4000, precision)).toBe(false);
    expect(meetsMinNotional(0.002, 4000, precision)).toBe(true);
    expect(meetsMinNotional(0.001, 5000, precision)).toBe(true);
  });

  it("uses the caller-supplied price so market orders can pass mark price", () => {
    const markPrice = 5000;
    expect(meetsMinNotional(0.001, markPrice, precision)).toBe(true);
    expect(meetsMinNotional(0.001, 4999, precision)).toBe(false);
  });

  it("treats a zero minNotional as no minimum", () => {
    expect(
      meetsMinNotional(0.001, 1, { ...precision, minNotional: 0 }),
    ).toBe(true);
  });
});
