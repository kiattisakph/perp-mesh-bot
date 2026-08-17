import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AccountState } from "../../src/domain/account";
import {
  applyAccountUpdate,
  intentToOrderParams,
  mapAccountV2,
  mapDepthDiff,
  mapDepthSnapshot,
  mapKlineEvent,
  mapListenKeyExpired,
  mapMarkPriceEvent,
  mapOrderTradeFill,
  mapOrderTradeUpdate,
  mapPositionRisk,
  mapRestOrder,
  mapTickerEvent,
} from "../../src/infrastructure/binance-usdm/mapper";
import { precisionFromExchangeInfo } from "../../src/infrastructure/binance-usdm/precision";
import { UnknownPrecisionError } from "../../src/infrastructure/binance-usdm/errors";
import { readFixture } from "../helpers/read-fixture";

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

describe("precision from exchangeInfo", () => {
  it("reads tickSize, stepSize, MARKET_LOT_SIZE, and MIN_NOTIONAL filters", () => {
    const precision = precisionFromExchangeInfo(
      readFixture("exchange-info.json"),
      "BLZUSDT",
    );
    expect(precision.tickSize).toBe(0.0001);
    expect(precision.stepSize).toBe(1);
    expect(precision.marketStepSize).toBe(1);
    expect(precision.minNotional).toBe(5);
    expect(precision.pricePrecision).toBe(5);
    expect(precision.quantityPrecision).toBe(0);
  });

  it("does not use pricePrecision as tick size", () => {
    const precision = precisionFromExchangeInfo(
      readFixture("exchange-info.json"),
      "BLZUSDT",
    );
    expect(precision.tickSize).not.toBe(precision.pricePrecision);
  });

  it("refuses to trade when filters are missing", () => {
    expect(() =>
      precisionFromExchangeInfo({ symbols: [{ symbol: "BTCUSDT" }] }, "BTCUSDT"),
    ).toThrow(UnknownPrecisionError);
  });
});

describe("canonical mappers", () => {
  it("emits account state from REST account + positionRisk", () => {
    const account = mapAccountV2(
      readFixture("account-v2.json"),
      mapPositionRisk(readFixture("position-risk-v2.json")),
    );
    expect(isPlainObject(account)).toBe(true);
    expect(account.walletBalance).toBe(23.72469206);
    expect(account.availableBalance).toBe(23.72469206);
    expect(account.positions).toHaveLength(1);
    const position = account.positions[0];
    expect(position?.symbol).toBe("BTCUSDT");
    expect(position?.quantity).toBe(0.001);
    expect(position?.entryPrice).toBe(22185.2);
    expect(position?.markPrice).toBe(21123.05052574);
    expect(position?.leverage).toBe(4);
    expect(position?.marginMode).toBe("isolated");
    expect(position?.liquidationPrice).toBe(19731.45529116);
  });

  it("applies ACCOUNT_UPDATE without using a CCXT object", () => {
    const previous: AccountState = {
      walletBalance: 10,
      availableBalance: 8,
      positions: [
        {
          symbol: "BTCUSDT",
          quantity: 0,
          entryPrice: 0,
          markPrice: 21123.05,
          unrealizedPnl: 0,
          leverage: 4,
          marginMode: "isolated",
          updateTime: 1,
        },
      ],
      updateTime: 1,
    };
    const account = applyAccountUpdate(
      previous,
      readFixture("account-update.json"),
    );
    expect(account.walletBalance).toBe(122624.12345678);
    expect(account.availableBalance).toBe(8);
    expect(account.positions[0]?.quantity).toBe(0.001);
    expect(account.positions[0]?.entryPrice).toBe(6563.665);
    expect(account.positions[0]?.unrealizedPnl).toBe(1.25);
    expect(account.positions[0]?.markPrice).toBe(21123.05);
    expect(account.positions[0]?.leverage).toBe(4);
    expect(account.positions[0]?.marginMode).toBe("isolated");
    expect(isPlainObject(account)).toBe(true);
  });

  it("maps ORDER_TRADE_UPDATE including TRADE partial fills", () => {
    const trailing = mapOrderTradeUpdate(readFixture("order-trade-update.json"));
    expect(trailing.type).toBe("TRAILING_STOP_MARKET");
    expect(trailing.status).toBe("NEW");
    expect(trailing.activationPrice).toBe(7476.89);
    expect(trailing.exchangeOrderId).toBe("8886774");

    const partial = mapOrderTradeUpdate(
      readFixture("order-trade-update-partial.json"),
    );
    expect(partial.status).toBe("PARTIALLY_FILLED");
    expect(partial.filledQuantity).toBe(0.001);
    expect(partial.quantity).toBe(0.002);
    expect(partial.reduceOnly).toBe(false);

    const fill = mapOrderTradeFill(
      readFixture("order-trade-update-partial.json"),
    );
    expect(fill.executionType).toBe("TRADE");
    expect(fill.lastFilledQuantity).toBe(0.001);
    expect(fill.lastFillPrice).toBe(20000);
    expect(fill.averageFillPrice).toBe(20000);
    expect(fill.order.filledQuantity).toBe(0.001);
  });

  it("maps EXPIRED_IN_MATCH to EXPIRED", () => {
    const order = mapRestOrder({
      orderId: 1,
      clientOrderId: "x",
      symbol: "BTCUSDT",
      side: "BUY",
      type: "LIMIT",
      origType: "LIMIT",
      status: "EXPIRED_IN_MATCH",
      origQty: "0.001",
      executedQty: "0",
      reduceOnly: false,
      updateTime: 1,
      price: "1",
    });
    expect(order.status).toBe("EXPIRED");
  });

  it("emits sorted depth with bid[0] and ask[0] as best", () => {
    const book = mapDepthSnapshot(readFixture("depth-snapshot.json"), "BTCUSDT");
    expect(book.bids.map((level) => level.price)).toEqual([4.1, 4, 3.9]);
    expect(book.asks.map((level) => level.price)).toEqual([
      4.000002, 4.05, 4.2,
    ]);
    expect(book.bids[0]?.price).toBeGreaterThan(book.bids[1]?.price ?? 0);
    expect(book.asks[0]?.price).toBeLessThan(book.asks[1]?.price ?? 0);
    expect(book.sequence).toBe(1027024);

    const diff = mapDepthDiff(readFixture("depth-diff.json"));
    expect(diff.bids[0]?.price).toBe(0.0026);
    expect(diff.asks[0]?.price).toBe(0.0025);
  });

  it("maps mark price from the mark stream, never ticker weighted average", () => {
    const mark = mapMarkPriceEvent(readFixture("mark-price.json"));
    expect(mark.markPrice).toBe(11794.15);
    const ticker = mapTickerEvent(readFixture("ticker.json"), mark.markPrice);
    expect(ticker.lastPrice).toBe(0.0025);
    expect(ticker.markPrice).toBe(11794.15);
    expect(ticker.markPrice).not.toBe(0.0018);
  });

  it("maps kline fields including the closed flag", () => {
    const candle = mapKlineEvent(readFixture("kline.json"));
    expect(candle.symbol).toBe("BTCUSDT");
    expect(candle.interval).toBe("1m");
    expect(candle.open).toBe(0.001);
    expect(candle.close).toBe(0.002);
    expect(candle.high).toBe(0.0025);
    expect(candle.low).toBe(0.0015);
    expect(candle.volume).toBe(1000);
    expect(candle.closed).toBe(false);
  });

  it("maps listenKeyExpired", () => {
    expect(mapListenKeyExpired(readFixture("listen-key-expired.json"))).toBe(
      true,
    );
  });

  it("maps REST place/cancel payloads for supported order types", () => {
    const limit = mapRestOrder(readFixture("rest-order-limit.json"));
    expect(limit.type).toBe("LIMIT");
    expect(limit.status).toBe("NEW");
    expect(limit.price).toBe(20000);
    const stop = mapRestOrder(readFixture("rest-order-stop.json"));
    expect(stop.type).toBe("STOP_MARKET");
    expect(stop.reduceOnly).toBe(true);
    expect(stop.stopPrice).toBe(19000);
    const canceled = mapRestOrder(readFixture("rest-order-cancel.json"));
    expect(canceled.status).toBe("CANCELED");
    expect(canceled.type).toBe("TRAILING_STOP_MARKET");
    expect(canceled.activationPrice).toBe(9020);
  });
});

describe("order intent mapping", () => {
  it("creates each supported Binance order type", () => {
    expect(
      intentToOrderParams(
        {
          type: "PLACE_LIMIT",
          strategyId: "maker",
          symbol: "BTCUSDT",
          side: "BUY",
          price: 20000,
          quantity: 0.001,
          postOnly: true,
          reduceOnly: false,
        },
        "id-limit",
      ),
    ).toMatchObject({
      type: "LIMIT",
      timeInForce: "GTX",
      reduceOnly: false,
      newClientOrderId: "id-limit",
    });
    expect(
      intentToOrderParams(
        {
          type: "PLACE_LIMIT",
          strategyId: "maker",
          symbol: "BTCUSDT",
          side: "SELL",
          price: 20000,
          quantity: 0.001,
          postOnly: false,
          reduceOnly: true,
        },
        "id-exit",
      ),
    ).toMatchObject({ type: "LIMIT", timeInForce: "GTC", reduceOnly: true });
    expect(
      intentToOrderParams(
        {
          type: "PLACE_MARKET",
          strategyId: "trend",
          symbol: "BTCUSDT",
          side: "BUY",
          quantity: 0.001,
          reduceOnly: false,
          reason: "entry",
        },
        "id-mkt",
      ),
    ).toMatchObject({ type: "MARKET", reduceOnly: false });
    expect(
      intentToOrderParams(
        {
          type: "PLACE_MARKET",
          strategyId: "trend",
          symbol: "BTCUSDT",
          side: "SELL",
          quantity: 0.001,
          reduceOnly: true,
          reason: "close",
        },
        "id-close",
      ),
    ).toMatchObject({ type: "MARKET", reduceOnly: true });
    expect(
      intentToOrderParams(
        {
          type: "PLACE_STOP",
          strategyId: "guardian",
          symbol: "BTCUSDT",
          side: "SELL",
          stopPrice: 19000,
          quantity: 0.001,
          reduceOnly: true,
        },
        "id-stop",
      ),
    ).toMatchObject({
      type: "STOP_MARKET",
      workingType: "MARK_PRICE",
      reduceOnly: true,
    });
    expect(
      intentToOrderParams(
        {
          type: "PLACE_TRAILING_STOP",
          strategyId: "guardian",
          symbol: "BTCUSDT",
          side: "SELL",
          activationPrice: 21000,
          callbackRate: 0.2,
          quantity: 0.001,
          reduceOnly: true,
        },
        "id-trail",
      ),
    ).toMatchObject({
      type: "TRAILING_STOP_MARKET",
      activationPrice: "21000",
      callbackRate: "0.2",
      reduceOnly: true,
    });
  });
});

describe("ccxt isolation", () => {
  it("does not import ccxt from domain or the Binance adapter", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (entry.name.endsWith(".ts")) {
          files.push(path);
        }
      }
    };
    walk(join(root, "src/domain"));
    walk(join(root, "src/infrastructure"));
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from ["']ccxt["']/);
      expect(source).not.toMatch(/require\(["']ccxt["']\)/);
    }
  });
});
