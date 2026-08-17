import { WebSocket } from "ws";
import type { AccountState } from "../../domain/account";
import type { OrderIntent } from "../../domain/intent";
import type { Candle, MarketTicker, OrderBook } from "../../domain/market";
import type { TradingOrder } from "../../domain/order";
import {
  isSendableQuantity,
  meetsMinNotional,
} from "../../domain/rounding";
import type { SymbolPrecision } from "../../domain/strategy";
import {
  resolveBinanceEndpoints,
  type BinanceEndpoints,
} from "./endpoints";
import {
  BinanceApiError,
  HedgeModeError,
  NO_NEED_TO_CHANGE_MARGIN_TYPE,
  UnknownPrecisionError,
} from "./errors";
import {
  intentToOrderParams,
  mapAccountV2,
  mapMarkPriceEvent,
  mapPositionRisk,
  mapRestKlines,
  mapRestOpenOrders,
  mapRestOrder,
  type PlaceIntent,
} from "./mapper";
import { precisionFromExchangeInfo } from "./precision";
import { PublicMarketStream, type PublicStreamHandlers } from "./public-stream";
import { BinanceRestClient, type HttpClient } from "./rest-client";
import type { MinimalSocket, WebSocketFactory } from "./socket";
import { UserDataStream, type UserStreamHandlers } from "./user-stream";

function defaultWebSocket(url: string): MinimalSocket {
  return new WebSocket(url);
}

export type BinanceAdapterOptions = {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  restUrl?: string;
  wsUrl?: string;
  reconnectMaxMs: number;
  strategyId?: string;
  recvWindowMs?: number;
  keepaliveMs?: number;
  now?: () => number;
  http?: HttpClient;
  webSocket?: WebSocketFactory;
  log?: (event: string, details?: Record<string, unknown>) => void;
};

export type BootstrapInput = {
  symbol: string;
  leverage: number;
  requireOneWay: boolean;
};

export type PublicSubscribeInput = {
  symbol: string;
  depth?: boolean;
  ticker?: boolean;
  mark?: boolean;
  klineInterval?: string;
  handlers?: PublicStreamHandlers;
};

function isPlaceIntent(intent: OrderIntent): intent is PlaceIntent {
  return (
    intent.type === "PLACE_LIMIT" ||
    intent.type === "PLACE_MARKET" ||
    intent.type === "PLACE_STOP" ||
    intent.type === "PLACE_TRAILING_STOP"
  );
}

export class BinanceUsdmAdapter {
  private readonly rest: BinanceRestClient;
  private readonly endpoints: BinanceEndpoints;
  private readonly webSocket: WebSocketFactory;
  private readonly reconnectMaxMs: number;
  private readonly strategyId: string;
  private readonly keepaliveMs?: number;
  private readonly log?: BinanceAdapterOptions["log"];
  private precision: SymbolPrecision | undefined;
  private publicStream: PublicMarketStream | undefined;
  private userStream: UserDataStream | undefined;
  private lastMarkPrice: number | undefined;

  constructor(options: BinanceAdapterOptions) {
    this.endpoints = resolveBinanceEndpoints({
      testnet: options.testnet,
      restUrl: options.restUrl,
      wsUrl: options.wsUrl,
    });
    this.rest = new BinanceRestClient({
      endpoints: this.endpoints,
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      recvWindowMs: options.recvWindowMs,
      now: options.now,
      http: options.http,
    });
    this.webSocket = options.webSocket ?? defaultWebSocket;
    this.reconnectMaxMs = options.reconnectMaxMs;
    this.strategyId = options.strategyId ?? "";
    this.keepaliveMs = options.keepaliveMs;
    this.log = options.log;
    this.log?.("binance_adapter_environment", {
      environment: this.endpoints.environment,
      restHost: new URL(this.endpoints.restBase).hostname,
      wsHost: new URL(this.endpoints.wsBase).hostname,
    });
  }

  get venue(): BinanceEndpoints {
    return this.endpoints;
  }

  async syncTime(): Promise<number> {
    return this.rest.syncTime();
  }

  async loadPrecision(symbol: string): Promise<SymbolPrecision> {
    const payload = await this.rest.publicGet("/fapi/v1/exchangeInfo");
    this.precision = precisionFromExchangeInfo(
      payload as { symbols?: Array<Record<string, unknown>> },
      symbol,
    );
    return this.precision;
  }

  loadedPrecision(): SymbolPrecision | undefined {
    return this.precision;
  }

  async ensureOneWay(requireOneWay: boolean): Promise<void> {
    const payload = await this.rest.signedRequest(
      "GET",
      "/fapi/v1/positionSide/dual",
    );
    const dual =
      payload !== null &&
      typeof payload === "object" &&
      "dualSidePosition" in payload &&
      (payload as { dualSidePosition: unknown }).dualSidePosition === true;
    if (dual) {
      throw new HedgeModeError(
        requireOneWay
          ? "account is in Hedge Mode; BINANCE_REQUIRE_ONE_WAY refused startup"
          : "account is in Hedge Mode; v1 requires One-way",
      );
    }
  }

  async setIsolated(symbol: string): Promise<void> {
    try {
      await this.rest.signedRequest("POST", "/fapi/v1/marginType", {
        symbol,
        marginType: "ISOLATED",
      });
    } catch (error) {
      if (
        error instanceof BinanceApiError &&
        error.code === NO_NEED_TO_CHANGE_MARGIN_TYPE
      ) {
        return;
      }
      throw error;
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.rest.signedRequest("POST", "/fapi/v1/leverage", {
      symbol,
      leverage,
    });
  }

  async fetchAccount(symbol: string): Promise<AccountState> {
    const [account, positions] = await Promise.all([
      this.rest.signedRequest("GET", "/fapi/v2/account"),
      this.rest.signedRequest("GET", "/fapi/v2/positionRisk", { symbol }),
    ]);
    return mapAccountV2(account, mapPositionRisk(positions));
  }

  async fetchOpenOrders(symbol: string): Promise<TradingOrder[]> {
    const payload = await this.rest.signedRequest("GET", "/fapi/v1/openOrders", {
      symbol,
    });
    return mapRestOpenOrders(payload, this.strategyId);
  }

  async fetchMarkPrice(symbol: string): Promise<number> {
    const payload = await this.rest.publicGet("/fapi/v1/premiumIndex", {
      symbol,
    });
    const mark = mapMarkPriceEvent(payload);
    this.lastMarkPrice = mark.markPrice;
    return mark.markPrice;
  }

  async fetchKlines(
    symbol: string,
    interval: string,
    limit?: number,
  ): Promise<Candle[]> {
    const params: Record<string, string | number> = { symbol, interval };
    if (limit !== undefined) {
      params.limit = limit;
    }
    const payload = await this.rest.publicGet("/fapi/v1/klines", params);
    return mapRestKlines(payload, symbol, interval);
  }

  async bootstrap(input: BootstrapInput): Promise<{
    precision: SymbolPrecision;
    account: AccountState;
    openOrders: TradingOrder[];
  }> {
    await this.syncTime();
    const precision = await this.loadPrecision(input.symbol);
    await this.ensureOneWay(input.requireOneWay);
    await this.setIsolated(input.symbol);
    await this.setLeverage(input.symbol, input.leverage);
    const [account, openOrders] = await Promise.all([
      this.fetchAccount(input.symbol),
      this.fetchOpenOrders(input.symbol),
    ]);
    return { precision, account, openOrders };
  }

  async placeFromIntent(
    intent: OrderIntent,
    newClientOrderId: string,
  ): Promise<TradingOrder> {
    if (!isPlaceIntent(intent)) {
      throw new Error(`${intent.type} is not a place intent`);
    }
    const precision = this.precision;
    if (precision === undefined) {
      throw new UnknownPrecisionError("exchange metadata is not loaded");
    }
    if (!isSendableQuantity(intent.quantity)) {
      throw new UnknownPrecisionError("quantity rounds to zero");
    }
    const priceForNotional =
      intent.type === "PLACE_LIMIT"
        ? intent.price
        : intent.type === "PLACE_STOP"
          ? intent.stopPrice
          : intent.type === "PLACE_TRAILING_STOP"
            ? intent.activationPrice
            : (this.lastMarkPrice ?? (await this.fetchMarkPrice(intent.symbol)));
    if (!meetsMinNotional(intent.quantity, priceForNotional, precision)) {
      throw new UnknownPrecisionError("below min notional");
    }
    const params = intentToOrderParams(intent, newClientOrderId);
    const payload = await this.rest.signedRequest(
      "POST",
      "/fapi/v1/order",
      params,
    );
    return mapRestOrder(payload, this.strategyId);
  }

  async cancelOrder(input: {
    symbol: string;
    orderId?: string;
    origClientOrderId?: string;
  }): Promise<TradingOrder> {
    const params: Record<string, string> = { symbol: input.symbol };
    if (input.orderId !== undefined) {
      params.orderId = input.orderId;
    }
    if (input.origClientOrderId !== undefined) {
      params.origClientOrderId = input.origClientOrderId;
    }
    const payload = await this.rest.signedRequest(
      "DELETE",
      "/fapi/v1/order",
      params,
    );
    return mapRestOrder(payload, this.strategyId);
  }

  async queryOrder(input: {
    symbol: string;
    orderId?: string;
    origClientOrderId?: string;
  }): Promise<TradingOrder> {
    const params: Record<string, string> = { symbol: input.symbol };
    if (input.orderId !== undefined) {
      params.orderId = input.orderId;
    }
    if (input.origClientOrderId !== undefined) {
      params.origClientOrderId = input.origClientOrderId;
    }
    const payload = await this.rest.signedRequest(
      "GET",
      "/fapi/v1/order",
      params,
    );
    return mapRestOrder(payload, this.strategyId);
  }

  async connectPublic(input: PublicSubscribeInput): Promise<void> {
    this.publicStream?.stop();
    this.publicStream = new PublicMarketStream({
      symbol: input.symbol,
      wsBase: this.endpoints.wsBase,
      rest: this.rest,
      webSocket: this.webSocket,
      reconnectMaxMs: this.reconnectMaxMs,
      depth: input.depth,
      ticker: input.ticker,
      mark: input.mark,
      klineInterval: input.klineInterval,
      handlers: {
        ...input.handlers,
        onMarkPrice: (markPrice, eventTime, symbol) => {
          this.lastMarkPrice = markPrice;
          input.handlers?.onMarkPrice?.(markPrice, eventTime, symbol);
        },
        onTicker: (ticker: MarketTicker) => {
          input.handlers?.onTicker?.(ticker);
        },
        onOrderBook: (book: OrderBook) => {
          input.handlers?.onOrderBook?.(book);
        },
      },
    });
    await this.publicStream.start();
  }

  async connectUser(
    account: AccountState,
    handlers: UserStreamHandlers = {},
  ): Promise<void> {
    await this.userStream?.stop();
    this.userStream = new UserDataStream({
      wsBase: this.endpoints.wsBase,
      rest: this.rest,
      webSocket: this.webSocket,
      reconnectMaxMs: this.reconnectMaxMs,
      keepaliveMs: this.keepaliveMs,
      strategyId: this.strategyId,
      initialAccount: account,
      handlers,
    });
    await this.userStream.start();
  }

  async disconnect(): Promise<void> {
    this.publicStream?.stop();
    this.publicStream = undefined;
    await this.userStream?.stop();
    this.userStream = undefined;
  }

  /**
   * Soak chaos: drop the live WebSocket without stopping the stream so
   * reconnect/reconcile can run. Public and user streams reconnect independently.
   */
  injectStreamDisconnect(target: "public" | "user" | "both"): void {
    if (target === "public" || target === "both") {
      this.publicStream?.injectDisconnect();
    }
    if (target === "user" || target === "both") {
      this.userStream?.injectDisconnect();
    }
  }
}
