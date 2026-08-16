import { describe, expect, it } from "vitest";
import {
  PRODUCTION_REST_BASE,
  PRODUCTION_WS_BASE,
  TESTNET_REST_BASE,
  TESTNET_WS_BASE,
  publicCombinedStreamUrl,
  publicStreamNames,
  resolveBinanceEndpoints,
  userStreamUrl,
} from "../../src/infrastructure/binance-usdm/endpoints";

describe("binance endpoints", () => {
  it("uses official testnet REST and market-stream hosts by default", () => {
    const endpoints = resolveBinanceEndpoints({ testnet: true });
    expect(endpoints.environment).toBe("testnet");
    expect(endpoints.restBase).toBe(TESTNET_REST_BASE);
    expect(endpoints.wsBase).toBe(TESTNET_WS_BASE);
    expect(TESTNET_REST_BASE).toBe("https://demo-fapi.binance.com");
    expect(TESTNET_WS_BASE).toBe("wss://fstream.binancefuture.com");
  });

  it("never uses custom hosts when production is selected", () => {
    const endpoints = resolveBinanceEndpoints({
      testnet: false,
      restUrl: "https://example.invalid",
      wsUrl: "wss://example.invalid",
    });
    expect(endpoints.environment).toBe("production");
    expect(endpoints.restBase).toBe(PRODUCTION_REST_BASE);
    expect(endpoints.wsBase).toBe(PRODUCTION_WS_BASE);
  });

  it("accepts testnet-only custom HTTPS/WSS bases", () => {
    const endpoints = resolveBinanceEndpoints({
      testnet: true,
      restUrl: "https://demo-fapi.binance.com/",
      wsUrl: "wss://fstream.binancefuture.com/",
    });
    expect(endpoints.restBase).toBe("https://demo-fapi.binance.com");
    expect(endpoints.wsBase).toBe("wss://fstream.binancefuture.com");
  });

  it("builds lowercase combined public streams and user listenKey URL", () => {
    expect(
      publicStreamNames({
        symbol: "BTCUSDT",
        depth: true,
        ticker: true,
        mark: true,
        klineInterval: "1m",
      }),
    ).toEqual([
      "btcusdt@depth@100ms",
      "btcusdt@ticker",
      "btcusdt@markPrice@1s",
      "btcusdt@kline_1m",
    ]);
    expect(
      publicCombinedStreamUrl("wss://fstream.binance.com", [
        "btcusdt@markPrice@1s",
      ]),
    ).toBe("wss://fstream.binance.com/stream?streams=btcusdt@markPrice@1s");
    expect(userStreamUrl("wss://fstream.binance.com", "abc")).toBe(
      "wss://fstream.binance.com/ws/abc",
    );
  });
});
