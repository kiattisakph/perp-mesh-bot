import { describe, expect, it } from "vitest";
import {
  isMarkSlippageAllowed,
  markSlippageDistance,
} from "../../src/risk/slippage";

describe("mark-price slippage", () => {
  it("allows a candidate within MAX_CLOSE_SLIPPAGE_FRACTION of mark", () => {
    expect(markSlippageDistance(100.5, 100)).toBeCloseTo(0.005);
    expect(isMarkSlippageAllowed(100.5, 100, 0.005)).toBe(true);
    expect(isMarkSlippageAllowed(100.4, 100, 0.005)).toBe(true);
  });

  it("blocks a market close that is farther than the fraction", () => {
    expect(isMarkSlippageAllowed(100.6, 100, 0.005)).toBe(false);
    expect(isMarkSlippageAllowed(99.4, 100, 0.005)).toBe(false);
  });
});
