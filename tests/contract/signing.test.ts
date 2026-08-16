import { describe, expect, it } from "vitest";
import { signQuery } from "../../src/infrastructure/binance-usdm/signing";
import { nextReconnectDelay } from "../../src/infrastructure/binance-usdm/reconnect";

describe("signing", () => {
  it("matches the official HMAC SHA256 SIGNED example", () => {
    const { query, signature } = signQuery(
      {
        symbol: "BTCUSDT",
        side: "BUY",
        type: "LIMIT",
        quantity: 1,
        price: 9000,
        timeInForce: "GTC",
        recvWindow: 5000,
        timestamp: 1591702613943,
      },
      "2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9",
    );
    expect(query).toBe(
      "symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943",
    );
    expect(signature).toBe(
      "3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9",
    );
  });
});

describe("reconnect backoff", () => {
  it("follows 3s → 6s → 12s capped at RECONNECT_MAX_MS", () => {
    expect(nextReconnectDelay(0, 60_000)).toBe(3000);
    expect(nextReconnectDelay(1, 60_000)).toBe(6000);
    expect(nextReconnectDelay(2, 60_000)).toBe(12_000);
    expect(nextReconnectDelay(5, 60_000)).toBe(60_000);
  });
});
