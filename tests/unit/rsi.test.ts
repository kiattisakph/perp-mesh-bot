import { describe, expect, it } from "vitest";
import { createRsi, rsiFromClosedCloses } from "../../src/indicators/rsi";

/** Alternating moves so RSI is not pinned at 0 or 100. */
const closed = [10, 11, 10.5, 11.5, 10.8, 12, 11, 12.5];

describe("RSI candle replacement", () => {
  it("replace updates the live candle instead of adding a new period", () => {
    const live = createRsi(3);
    live.updates(closed);
    live.add(12);
    const beforeReplace = live.getResultOrThrow();
    live.replace(9);
    const replaced = live.getResultOrThrow();

    const addedAsNew = createRsi(3);
    addedAsNew.updates(closed);
    addedAsNew.add(12);
    addedAsNew.add(9);

    expect(replaced).not.toBe(beforeReplace);
    expect(replaced).not.toBe(addedAsNew.getResultOrThrow());
    expect(rsiFromClosedCloses([...closed, 9], 3)).toBe(replaced);
  });
});

describe("RSI new-candle update", () => {
  it("add incorporates a newly closed candle", () => {
    const rsi = createRsi(3);
    rsi.updates(closed);
    const before = rsi.getResultOrThrow();
    rsi.add(8);
    expect(rsi.getResultOrThrow()).not.toBe(before);
    expect(rsiFromClosedCloses([...closed, 8], 3)).toBe(rsi.getResultOrThrow());
  });

  it("returns null until trading-signals reports a stable RSI", () => {
    expect(rsiFromClosedCloses([1, 2], 3)).toBeNull();
    expect(rsiFromClosedCloses([1, 2, 3, 4], 3)).not.toBeNull();
  });

  it("rejects a non-positive period", () => {
    expect(() => createRsi(0)).toThrow(/period/);
    expect(() => rsiFromClosedCloses([1, 2, 3], 0)).toThrow(/period/);
  });
});
