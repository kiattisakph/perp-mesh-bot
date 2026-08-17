import { describe, expect, it } from "vitest";
import { isFeedStale } from "../../src/risk/freshness";

describe("feed freshness", () => {
  it("treats a feed older than FEED_STALE_MS as stale", () => {
    expect(
      isFeedStale({ eventTime: 0, now: 10_001, staleMs: 10_000 }),
    ).toBe(true);
    expect(
      isFeedStale({ eventTime: 0, now: 10_000, staleMs: 10_000 }),
    ).toBe(false);
  });
});
