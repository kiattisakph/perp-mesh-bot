import { describe, expect, it } from "vitest";
import {
  BinanceApiError,
  RateLimitError,
  UnknownExecutionError,
} from "../../src/infrastructure/binance-usdm/errors";
import { resolveBinanceEndpoints } from "../../src/infrastructure/binance-usdm/endpoints";
import {
  BinanceRestClient,
  type HttpClient,
} from "../../src/infrastructure/binance-usdm/rest-client";

function client(http: HttpClient, now = () => 1591702613943): BinanceRestClient {
  return new BinanceRestClient({
    endpoints: resolveBinanceEndpoints({ testnet: true }),
    apiKey: "dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83",
    apiSecret: "2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9",
    now,
    http,
  });
}

describe("rest client", () => {
  it("signs TRADE requests with HMAC and does not put the secret in the URL", async () => {
    let seenUrl = "";
    const rest = client(async (request) => {
      if (request.url.endsWith("/fapi/v1/time")) {
        return {
          status: 200,
          headers: { get: () => null },
          text: JSON.stringify({ serverTime: 1591702613943 }),
        };
      }
      seenUrl = request.url;
      expect(request.headers["X-MBX-APIKEY"]).toBe(
        "dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83",
      );
      expect(request.url).not.toContain(
        "2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9",
      );
      return {
        status: 200,
        headers: { get: () => null },
        text: JSON.stringify({ orderId: 1, status: "NEW" }),
      };
    });
    await rest.signedRequest("POST", "/fapi/v1/order", {
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      price: 9000,
      timeInForce: "GTC",
    });
    expect(seenUrl).toBe("https://demo-fapi.binance.com/fapi/v1/order");
  });

  it("uses the official HMAC example signature when timestamp is fixed", async () => {
    let body = "";
    const http: HttpClient = async (request) => {
      if (request.url.endsWith("/fapi/v1/time")) {
        return {
          status: 200,
          headers: { get: () => null },
          text: JSON.stringify({ serverTime: 1591702613943 }),
        };
      }
      body = request.body ?? "";
      return {
        status: 200,
        headers: { get: () => null },
        text: "{}",
      };
    };
    const rest = client(http, () => 1591702613943);
    await rest.syncTime();
    await rest.signedRequest("POST", "/fapi/v1/order", {
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      price: 9000,
      timeInForce: "GTC",
    });
    expect(body).toContain(
      "signature=3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9",
    );
  });

  it("treats HTTP 503 unknown execution as unknown, not a failed place", async () => {
    const rest = client(async (request) => {
      if (request.url.endsWith("/fapi/v1/time")) {
        return {
          status: 200,
          headers: { get: () => null },
          text: JSON.stringify({ serverTime: 1 }),
        };
      }
      return {
        status: 503,
        headers: { get: () => null },
        text: JSON.stringify({
          msg: "Unknown error, please check your request or try again later.",
        }),
      };
    });
    await rest.syncTime();
    await expect(rest.signedRequest("POST", "/fapi/v1/order")).rejects.toBeInstanceOf(
      UnknownExecutionError,
    );
  });

  it("surfaces 429 as a rate-limit error", async () => {
    const rest = client(async () => ({
      status: 429,
      headers: { get: (name) => (name === "Retry-After" ? "2" : null) },
      text: "",
    }));
    await expect(rest.publicGet("/fapi/v1/time")).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("maps negative Binance codes without attaching the request URL", async () => {
    const rest = client(async () => ({
      status: 400,
      headers: { get: () => null },
      text: JSON.stringify({ code: -1121, msg: "Invalid symbol." }),
    }));
    try {
      await rest.publicGet("/fapi/v1/depth", { symbol: "NOPE" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BinanceApiError);
      expect((error as BinanceApiError).code).toBe(-1121);
      expect((error as Error).message).toBe("Invalid symbol.");
      expect((error as Error).message).not.toMatch(/demo-fapi/);
    }
  });
});
