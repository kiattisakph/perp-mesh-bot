import type { Candle, MarketTicker, OrderBook } from "../../domain/market";
import {
  DEPTH_SNAPSHOT_LIMIT,
  publicCombinedStreamUrl,
  publicStreamNames,
} from "./endpoints";
import {
  eventTypeOf,
  mapDepthSnapshot,
  mapKlineEvent,
  mapMarkPriceEvent,
  mapTickerEvent,
  unwrapStreamPayload,
} from "./mapper";
import { LocalOrderBook, parseDepthDiff } from "./local-book";
import { nextReconnectDelay } from "./reconnect";
import type { BinanceRestClient } from "./rest-client";
import {
  parseJsonMessage,
  type MinimalSocket,
  type WebSocketFactory,
} from "./socket";

export type PublicStreamHandlers = {
  onOrderBook?: (book: OrderBook) => void;
  onTicker?: (ticker: MarketTicker) => void;
  onMarkPrice?: (markPrice: number, eventTime: number, symbol: string) => void;
  onKline?: (candle: Candle) => void;
  onReconnect?: () => void;
};

export type PublicStreamOptions = {
  symbol: string;
  wsBase: string;
  rest: BinanceRestClient;
  webSocket: WebSocketFactory;
  reconnectMaxMs: number;
  depth?: boolean;
  ticker?: boolean;
  mark?: boolean;
  klineInterval?: string;
  handlers: PublicStreamHandlers;
  delay?: (ms: number) => Promise<void>;
};

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class PublicMarketStream {
  private readonly options: PublicStreamOptions;
  private readonly book = new LocalOrderBook();
  private socket: MinimalSocket | undefined;
  private stopped = false;
  private attempt = 0;
  private lastMarkPrice: number | undefined;
  private reconnecting: Promise<void> | undefined;

  constructor(options: PublicStreamOptions) {
    this.options = options;
  }

  get markPrice(): number | undefined {
    return this.lastMarkPrice;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = undefined;
  }

  /** Close the live socket so reconnect runs. Does not mark the stream stopped. */
  injectDisconnect(): void {
    this.socket?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const streams = publicStreamNames({
      symbol: this.options.symbol,
      depth: this.options.depth,
      ticker: this.options.ticker,
      mark: this.options.mark,
      klineInterval: this.options.klineInterval,
    });
    const url = publicCombinedStreamUrl(this.options.wsBase, streams);
    if (this.options.depth === true) {
      this.book.startBuffering();
    }
    const socket = this.options.webSocket(url);
    this.socket = socket;
    socket.on("message", (data) => {
      void this.onMessage(data).catch(() => undefined);
    });
    socket.on("close", () => {
      if (this.socket !== socket) {
        return;
      }
      void this.scheduleReconnect();
    });
    socket.on("error", () => {
      socket.close();
    });
    if (this.options.depth === true) {
      await this.rebuildBook();
    }
  }

  private async onMessage(data: unknown): Promise<void> {
    const payload = unwrapStreamPayload(parseJsonMessage(data));
    const eventType = eventTypeOf(payload);
    if (eventType === "depthUpdate") {
      const status = this.book.applyDiff(parseDepthDiff(payload));
      if (status === "gap") {
        await this.rebuildBook();
        return;
      }
      const snapshot = this.book.snapshot();
      if (snapshot !== undefined) {
        this.options.handlers.onOrderBook?.(snapshot);
      }
      return;
    }
    if (eventType === "markPriceUpdate") {
      const mark = mapMarkPriceEvent(payload);
      this.lastMarkPrice = mark.markPrice;
      this.options.handlers.onMarkPrice?.(
        mark.markPrice,
        mark.eventTime,
        mark.symbol,
      );
      return;
    }
    if (eventType === "24hrTicker") {
      if (this.lastMarkPrice === undefined) {
        return;
      }
      const ticker = mapTickerEvent(payload, this.lastMarkPrice);
      this.options.handlers.onTicker?.(ticker);
      return;
    }
    if (eventType === "kline") {
      this.options.handlers.onKline?.(mapKlineEvent(payload));
    }
  }

  private async rebuildBook(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.book.startBuffering();
      const payload = await this.options.rest.publicGet("/fapi/v1/depth", {
        symbol: this.options.symbol,
        limit: DEPTH_SNAPSHOT_LIMIT,
      });
      const status = this.book.applySnapshot(
        mapDepthSnapshot(payload, this.options.symbol),
      );
      if (status === "gap") {
        continue;
      }
      const snapshot = this.book.snapshot();
      if (snapshot !== undefined) {
        this.options.handlers.onOrderBook?.(snapshot);
      }
      return;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.stopped || this.reconnecting !== undefined) {
      return;
    }
    const wait = nextReconnectDelay(this.attempt, this.options.reconnectMaxMs);
    this.attempt += 1;
    this.reconnecting = this.options.delay?.(wait) ?? defaultDelay(wait);
    await this.reconnecting;
    this.reconnecting = undefined;
    if (this.stopped) {
      return;
    }
    this.options.handlers.onReconnect?.();
    await this.connect();
    this.attempt = 0;
  }
}
