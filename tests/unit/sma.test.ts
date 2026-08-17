import { describe, expect, it } from "vitest";
import { sma } from "../../src/indicators/sma";

describe("SMA", () => {
  it("averages the last n closed closes", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(sma([10, 20, 30], 3)).toBe(20);
  });

  it("does not use values before the lookback window", () => {
    expect(sma([100, 1, 1, 1], 3)).toBe(1);
  });

  it("rejects a short series or a non-positive period", () => {
    expect(() => sma([1, 2], 3)).toThrow(/at least 3/);
    expect(() => sma([1, 2, 3], 0)).toThrow(/period/);
  });
});
