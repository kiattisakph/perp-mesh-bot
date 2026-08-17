import { describe, expect, it } from "vitest";
import {
  auditOrphanOrders,
  auditPositionMismatch,
  createOrderOwnership,
} from "../../src/application";
import { isFlat } from "../../src/domain/position";
import { BinanceUsdmAdapter } from "../../src/infrastructure/binance-usdm/binance-adapter";

const apiKey = process.env.BINANCE_API_KEY ?? "";
const apiSecret = process.env.BINANCE_API_SECRET ?? "";
const hasKeys = apiKey !== "" && apiSecret !== "";

describe.skipIf(!hasKeys)("testnet soak audit probe", () => {
  it("audits orphans and position without claiming production-ready", async () => {
    const symbol = (process.env.BINANCE_SYMBOL ?? "BTCUSDT").toUpperCase();
    const ownership = createOrderOwnership({
      strategyId: "guardian",
      instanceId: "soak",
    });
    const adapter = new BinanceUsdmAdapter({
      apiKey,
      apiSecret,
      testnet: true,
      reconnectMaxMs: 60_000,
      strategyId: "guardian",
    });
    const account = await adapter.fetchAccount(symbol);
    const openOrders = await adapter.fetchOpenOrders(symbol);
    const position =
      account.positions.find(
        (row) => row.symbol === symbol && !isFlat(row.quantity),
      ) ?? null;
    const orphans = auditOrphanOrders({
      trackedOrders: openOrders.filter((order) =>
        order.clientOrderId.startsWith(ownership.prefix),
      ),
      exchangeOpenOrders: openOrders,
      ownership,
    });
    const mismatch = auditPositionMismatch({
      symbol,
      snapshotPosition: position,
      exchangeAccount: account,
    });
    expect(orphans).toEqual([]);
    expect(mismatch).toBeUndefined();
    expect({ productionReady: false as const }.productionReady).toBe(false);
  }, 30_000);
});
