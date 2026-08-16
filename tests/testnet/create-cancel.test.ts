import { describe, expect, it } from "vitest";
import {
  roundDownToStep,
  roundMakerPrice,
} from "../../src/domain/rounding";
import { BinanceUsdmAdapter } from "../../src/infrastructure/binance-usdm/binance-adapter";
import { TESTNET_REST_BASE } from "../../src/infrastructure/binance-usdm/endpoints";

const apiKey = process.env.BINANCE_API_KEY ?? "";
const apiSecret = process.env.BINANCE_API_SECRET ?? "";
const hasKeys = apiKey !== "" && apiSecret !== "";

describe("testnet hosts", () => {
  it("serves /fapi/v1/time on the official REST testnet base", async () => {
    const response = await fetch(`${TESTNET_REST_BASE}/fapi/v1/time`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { serverTime?: number };
    expect(body.serverTime).toBeGreaterThan(1_700_000_000_000);
  });
});

describe.skipIf(!hasKeys)("testnet create/cancel round-trip", () => {
  it("places a post-only limit far from the market and cancels it", async () => {
    const symbol = (process.env.BINANCE_SYMBOL ?? "BTCUSDT").toUpperCase();
    const adapter = new BinanceUsdmAdapter({
      apiKey,
      apiSecret,
      testnet: true,
      reconnectMaxMs: 60_000,
      strategyId: "contract",
    });
    const precision = await adapter.loadPrecision(symbol);
    const markPrice = await adapter.fetchMarkPrice(symbol);
    const rawPrice = markPrice * 0.7;
    const price = roundMakerPrice(rawPrice, "BUY", precision);
    const minQty = Math.max(
      precision.stepSize,
      precision.minNotional / price,
    );
    const quantity = roundDownToStep(
      minQty + precision.stepSize,
      precision.stepSize,
    );
    const clientOrderId = `pmbt3${Date.now()}`;
    const placed = await adapter.placeFromIntent(
      {
        type: "PLACE_LIMIT",
        strategyId: "contract",
        symbol,
        side: "BUY",
        price,
        quantity,
        postOnly: true,
        reduceOnly: false,
      },
      clientOrderId,
    );
    expect(placed.clientOrderId).toBe(clientOrderId);
    expect(placed.status).toBe("NEW");
    const canceled = await adapter.cancelOrder({
      symbol,
      origClientOrderId: clientOrderId,
    });
    expect(canceled.status).toBe("CANCELED");
  }, 20_000);
});
