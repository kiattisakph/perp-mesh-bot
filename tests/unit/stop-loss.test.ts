import { describe, expect, it } from "vitest";
import {
  isRiskReducingStopMove,
  percentStopPrice,
  usdStopPrice,
} from "../../src/risk/stop-loss";

describe("USD stop", () => {
  it("places long and short stops from lossUsd / quantity", () => {
    expect(
      usdStopPrice({ entryPrice: 100, quantity: 2, lossUsd: 4 }),
    ).toBe(98);
    expect(
      usdStopPrice({ entryPrice: 100, quantity: -2, lossUsd: 4 }),
    ).toBe(102);
  });
});

describe("percentage stop", () => {
  it("places long and short stops from a fraction of entry", () => {
    expect(
      percentStopPrice({
        entryPrice: 100,
        quantity: 1,
        stopLossFraction: 0.05,
      }),
    ).toBe(95);
    expect(
      percentStopPrice({
        entryPrice: 100,
        quantity: -1,
        stopLossFraction: 0.05,
      }),
    ).toBe(105);
  });
});

describe("risk-reducing stop moves", () => {
  it("only allows long stops to move up and short stops to move down", () => {
    expect(
      isRiskReducingStopMove({
        quantity: 1,
        previousStop: 98,
        nextStop: 99,
      }),
    ).toBe(true);
    expect(
      isRiskReducingStopMove({
        quantity: 1,
        previousStop: 98,
        nextStop: 97,
      }),
    ).toBe(false);
    expect(
      isRiskReducingStopMove({
        quantity: -1,
        previousStop: 102,
        nextStop: 101,
      }),
    ).toBe(true);
    expect(
      isRiskReducingStopMove({
        quantity: -1,
        previousStop: 102,
        nextStop: 103,
      }),
    ).toBe(false);
  });
});
