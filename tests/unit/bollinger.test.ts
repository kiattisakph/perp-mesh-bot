import { describe, expect, it } from "vitest";
import {
  bollingerBandwidth,
  populationStandardDeviation,
} from "../../src/indicators/bollinger";

describe("Bollinger bandwidth", () => {
  it("uses population standard deviation (divide by n)", () => {
    const closes = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(populationStandardDeviation(closes)).toBe(2);
    expect(bollingerBandwidth(closes, 8, 2)).toBe(1.6);
  });

  it("uses only the last length closes", () => {
    const closes = [0, 2, 4, 4, 4, 5, 5, 7, 9];
    expect(bollingerBandwidth(closes, 8, 2)).toBe(1.6);
  });

  it("rejects a zero mean, short series, or non-positive multiplier", () => {
    expect(() => bollingerBandwidth([0, 0, 0], 3, 2)).toThrow(/non-zero/);
    expect(() => bollingerBandwidth([1, 2], 3, 2)).toThrow(/at least 3/);
    expect(() => bollingerBandwidth([1, 2, 3], 3, 0)).toThrow(/multiplier/);
  });
});
