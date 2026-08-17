import { describe, expect, it } from "vitest";
import type { AccountState } from "../../src/domain/account";
import type { OrderBook } from "../../src/domain/market";
import type { TradingOrder } from "../../src/domain/order";
import { BinanceUsdmAdapter } from "../../src/infrastructure/binance-usdm/binance-adapter";
import { HedgeModeError } from "../../src/infrastructure/binance-usdm/errors";
import { resolveBinanceEndpoints } from "../../src/infrastructure/binance-usdm/endpoints";
import { LocalOrderBook, parseDepthDiff } from "../../src/infrastructure/binance-usdm/local-book";
import { mapDepthSnapshot } from "../../src/infrastructure/binance-usdm/mapper";
import {
  BinanceRestClient,
  type HttpClient,
} from "../../src/infrastructure/binance-usdm/rest-client";
import { UserDataStream } from "../../src/infrastructure/binance-usdm/user-stream";
import { PublicMarketStream } from "../../src/infrastructure/binance-usdm/public-stream";
import { FakeSocket, fakeWebSocket } from "../helpers/fake-socket";
import { readFixture } from "../helpers/read-fixture";

const emptyAccount: AccountState = {
  walletBalance: 100,
  availableBalance: 100,
  positions: [],
  updateTime: 1,
};

function jsonOk(body: unknown) {
  return {
    status: 200,
    headers: { get: () => null },
    text: JSON.stringify(body),
  };
}

describe("local order book", () => {
  it("rebuilds on a sequence gap", () => {
    const book = new LocalOrderBook();
    book.startBuffering();
    const snapshot = mapDepthSnapshot(
      {
        lastUpdateId: 160,
        E: 1,
        bids: [["100", "1"]],
        asks: [["101", "1"]],
      },
      "BTCUSDT",
    );
    expect(book.applySnapshot(snapshot)).toBe("ready");
    expect(
      book.applyDiff(
        parseDepthDiff({
          e: "depthUpdate",
          E: 2,
          s: "BTCUSDT",
          U: 200,
          u: 201,
          pu: 199,
          b: [["100", "2"]],
          a: [],
        }),
      ),
    ).toBe("gap");
  });

  it("applies a bridging first event then contiguous pu", () => {
    const book = new LocalOrderBook();
    book.startBuffering();
    book.applySnapshot(
      mapDepthSnapshot(
        {
          lastUpdateId: 160,
          E: 1,
          bids: [["100", "1"]],
          asks: [["101", "1"]],
        },
        "BTCUSDT",
      ),
    );
    expect(
      book.applyDiff(
        parseDepthDiff({
          e: "depthUpdate",
          E: 2,
          s: "BTCUSDT",
          U: 157,
          u: 160,
          pu: 149,
          b: [["100", "2"]],
          a: [],
        }),
      ),
    ).toBe("ready");
    expect(
      book.applyDiff(
        parseDepthDiff({
          e: "depthUpdate",
          E: 3,
          s: "BTCUSDT",
          U: 161,
          u: 162,
          pu: 160,
          b: [["99", "1"]],
          a: [],
        }),
      ),
    ).toBe("ready");
    const current = book.snapshot();
    expect(current?.bids[0]?.price).toBe(100);
    expect(current?.bids[0]?.quantity).toBe(2);
  });
});

describe("adapter bootstrap and cancel", () => {
  it("refuses Hedge Mode instead of changing account-wide position mode", async () => {
    const http: HttpClient = async (request) => {
      if (request.url.includes("/fapi/v1/time")) {
        return jsonOk({ serverTime: Date.now() });
      }
      if (request.url.includes("/fapi/v1/exchangeInfo")) {
        return jsonOk(readFixture("exchange-info.json"));
      }
      if (request.url.includes("/fapi/v1/positionSide/dual")) {
        return jsonOk({ dualSidePosition: true });
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    const adapter = new BinanceUsdmAdapter({
      apiKey: "k",
      apiSecret: "s",
      testnet: true,
      reconnectMaxMs: 60_000,
      http,
    });
    await expect(
      adapter.bootstrap({
        symbol: "BLZUSDT",
        leverage: 3,
        requireOneWay: true,
      }),
    ).rejects.toBeInstanceOf(HedgeModeError);
  });

  it("cancels by origClientOrderId and never calls allOpenOrders", async () => {
    const paths: string[] = [];
    const http: HttpClient = async (request) => {
      const url = new URL(request.url);
      paths.push(`${request.method} ${url.pathname}`);
      if (url.pathname.endsWith("/fapi/v1/time")) {
        return jsonOk({ serverTime: 1 });
      }
      if (request.method === "DELETE" && url.pathname.endsWith("/fapi/v1/order")) {
        expect(request.url).toContain("origClientOrderId=pmb-limit-1");
        return jsonOk(readFixture("rest-order-cancel.json"));
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    const adapter = new BinanceUsdmAdapter({
      apiKey: "k",
      apiSecret: "s",
      testnet: true,
      reconnectMaxMs: 60_000,
      http,
    });
    await adapter.syncTime();
    const canceled = await adapter.cancelOrder({
      symbol: "BTCUSDT",
      origClientOrderId: "pmb-limit-1",
    });
    expect(canceled.status).toBe("CANCELED");
    expect(canceled.clientOrderId).toBe("myOrder1");
    expect(paths.join(" ")).not.toContain("allOpenOrders");
  });
});

describe("stream reconnect", () => {
  it("reconnects the user stream independently after close", async () => {
    FakeSocket.reset();
    const waits: number[] = [];
    let listenKeys = 0;
    const http: HttpClient = async (request) => {
      if (request.url.includes("/fapi/v1/listenKey") && request.method === "POST") {
        listenKeys += 1;
        return jsonOk({ listenKey: `key-${listenKeys}` });
      }
      if (request.url.includes("/fapi/v1/listenKey")) {
        return jsonOk({});
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    const rest = new BinanceRestClient({
      endpoints: resolveBinanceEndpoints({ testnet: true }),
      apiKey: "k",
      apiSecret: "s",
      http,
    });
    let reconnects = 0;
    const user = new UserDataStream({
      wsBase: "wss://fstream.binancefuture.com",
      rest,
      webSocket: fakeWebSocket,
      reconnectMaxMs: 60_000,
      initialAccount: emptyAccount,
      handlers: {
        onReconnect: () => {
          reconnects += 1;
        },
      },
      delay: async (ms) => {
        waits.push(ms);
      },
    });
    await user.start();
    expect(FakeSocket.instances[0]?.url).toBe(
      "wss://fstream.binancefuture.com/ws/key-1",
    );
    FakeSocket.instances[0]?.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waits[0]).toBe(3000);
    expect(reconnects).toBe(1);
    expect(FakeSocket.instances[1]?.url).toBe(
      "wss://fstream.binancefuture.com/ws/key-2",
    );
    await user.stop();
  });

  it("injectDisconnect on user and public streams reconnects without a full stop", async () => {
    FakeSocket.reset();
    let listenKeys = 0;
    const http: HttpClient = async (request) => {
      if (request.url.includes("/fapi/v1/listenKey") && request.method === "POST") {
        listenKeys += 1;
        return jsonOk({ listenKey: `key-${listenKeys}` });
      }
      if (request.url.includes("/fapi/v1/listenKey")) {
        return jsonOk({});
      }
      if (request.url.includes("/fapi/v1/depth")) {
        return jsonOk(readFixture("depth-snapshot.json"));
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    const rest = new BinanceRestClient({
      endpoints: resolveBinanceEndpoints({ testnet: true }),
      apiKey: "k",
      apiSecret: "s",
      http,
    });
    let userReconnects = 0;
    const user = new UserDataStream({
      wsBase: "wss://fstream.binancefuture.com",
      rest,
      webSocket: fakeWebSocket,
      reconnectMaxMs: 60_000,
      initialAccount: emptyAccount,
      handlers: {
        onReconnect: () => {
          userReconnects += 1;
        },
      },
      delay: async () => undefined,
    });
    await user.start();
    user.injectDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(userReconnects).toBe(1);
    expect(listenKeys).toBe(2);
    await user.stop();

    FakeSocket.reset();
    let publicReconnects = 0;
    const publicStream = new PublicMarketStream({
      symbol: "BTCUSDT",
      wsBase: "wss://fstream.binancefuture.com",
      rest,
      webSocket: fakeWebSocket,
      reconnectMaxMs: 60_000,
      mark: true,
      handlers: {
        onReconnect: () => {
          publicReconnects += 1;
        },
      },
      delay: async () => undefined,
    });
    await publicStream.start();
    publicStream.injectDisconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publicReconnects).toBe(1);
    publicStream.stop();
  });

  it("maps user-stream account and order updates to domain types", async () => {
    FakeSocket.reset();
    const http: HttpClient = async (request) => {
      if (request.url.includes("/fapi/v1/listenKey") && request.method === "POST") {
        return jsonOk({ listenKey: "user-key" });
      }
      if (request.url.includes("/fapi/v1/listenKey")) {
        return jsonOk({});
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    const rest = new BinanceRestClient({
      endpoints: resolveBinanceEndpoints({ testnet: true }),
      apiKey: "k",
      apiSecret: "s",
      http,
    });
    const accounts: AccountState[] = [];
    const orders: TradingOrder[] = [];
    const user = new UserDataStream({
      wsBase: "wss://fstream.binancefuture.com",
      rest,
      webSocket: fakeWebSocket,
      reconnectMaxMs: 60_000,
      initialAccount: emptyAccount,
      handlers: {
        onAccount: (account) => accounts.push(account),
        onOrder: (order) => orders.push(order),
      },
    });
    await user.start();
    FakeSocket.instances[0]?.emit(
      "message",
      JSON.stringify(readFixture("account-update.json")),
    );
    FakeSocket.instances[0]?.emit(
      "message",
      JSON.stringify(readFixture("order-trade-update-partial.json")),
    );
    expect(accounts[0]?.walletBalance).toBe(122624.12345678);
    expect(orders[0]?.status).toBe("PARTIALLY_FILLED");
    expect(orders[0]?.filledQuantity).toBe(0.001);
    await user.stop();
  });

  it("maps public depth, mark, and kline from combined stream frames", async () => {
    FakeSocket.reset();
    const books: OrderBook[] = [];
    const marks: number[] = [];
    const http: HttpClient = async (request) => {
      if (request.url.includes("/fapi/v1/depth")) {
        return jsonOk(readFixture("depth-snapshot.json"));
      }
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    const adapter = new BinanceUsdmAdapter({
      apiKey: "k",
      apiSecret: "s",
      testnet: true,
      reconnectMaxMs: 60_000,
      http,
      webSocket: fakeWebSocket,
    });
    await adapter.connectPublic({
      symbol: "BTCUSDT",
      depth: true,
      mark: true,
      klineInterval: "1m",
      handlers: {
        onOrderBook: (book) => books.push(book),
        onMarkPrice: (price) => marks.push(price),
      },
    });
    const socket = FakeSocket.instances[0];
    expect(socket?.url).toContain("btcusdt@depth@100ms");
    expect(socket?.url).toContain("btcusdt@markPrice@1s");
    socket?.emit(
      "message",
      JSON.stringify({
        stream: "btcusdt@markPrice@1s",
        data: readFixture("mark-price.json"),
      }),
    );
    expect(marks[0]).toBe(11794.15);
    expect(books[0]?.bids[0]?.price).toBe(4.1);
    await adapter.disconnect();
  });
});
