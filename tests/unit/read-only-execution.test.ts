import { describe, expect, it } from "vitest";
import { ExecutionService } from "../../src/application/execution-service";
import { FakeVenue } from "../helpers/fake-venue";
import { btcPrecision, testAccount, testOwnership } from "../helpers/trading-fixtures";

const ownership = testOwnership();

const entryIntent = {
  type: "PLACE_MARKET" as const,
  strategyId: "trend",
  symbol: "BTCUSDT",
  side: "BUY" as const,
  quantity: 0.001,
  reduceOnly: false,
  reason: "entry",
};

describe("read-only execution", () => {
  it("places no orders", async () => {
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(),
    });
    const execution = new ExecutionService(
      venue,
      ownership,
      undefined,
      1,
      "read-only",
    );
    expect(execution.placesOrders).toBe(false);
    const result = await execution.execute([entryIntent], {
      symbol: "BTCUSDT",
      ownership,
      openOrders: [],
    });
    expect(result.placed).toEqual([]);
    expect(result.skipped).toEqual([entryIntent]);
    expect(venue.placeCalls).toEqual([]);
    expect(venue.cancelAllOrdersCalls).toBe(0);
  });
});
