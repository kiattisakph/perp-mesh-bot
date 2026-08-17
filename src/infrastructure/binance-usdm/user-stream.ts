import type { AccountState } from "../../domain/account";
import type { TradingOrder } from "../../domain/order";
import { LISTEN_KEY_KEEPALIVE_MS, userStreamUrl } from "./endpoints";
import { BinanceApiError, INVALID_LISTEN_KEY } from "./errors";
import {
  applyAccountUpdate,
  eventTypeOf,
  mapListenKeyExpired,
  mapOrderTradeUpdate,
} from "./mapper";
import { nextReconnectDelay } from "./reconnect";
import type { BinanceRestClient } from "./rest-client";
import {
  parseJsonMessage,
  type MinimalSocket,
  type WebSocketFactory,
} from "./socket";

export type UserStreamHandlers = {
  onAccount?: (account: AccountState) => void;
  onOrder?: (order: TradingOrder) => void;
  onListenKeyExpired?: () => void;
  onReconnect?: () => void;
};

export type UserStreamOptions = {
  wsBase: string;
  rest: BinanceRestClient;
  webSocket: WebSocketFactory;
  reconnectMaxMs: number;
  keepaliveMs?: number;
  strategyId?: string;
  handlers: UserStreamHandlers;
  delay?: (ms: number) => Promise<void>;
  initialAccount: AccountState;
};

const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class UserDataStream {
  private readonly options: UserStreamOptions;
  private socket: MinimalSocket | undefined;
  private listenKey: string | undefined;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private attempt = 0;
  private account: AccountState;
  private reconnecting: Promise<void> | undefined;

  constructor(options: UserStreamOptions) {
    this.options = options;
    this.account = options.initialAccount;
  }

  get currentAccount(): AccountState {
    return this.account;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearKeepalive();
    this.socket?.close();
    this.socket = undefined;
    try {
      await this.options.rest.apiKeyRequest("DELETE", "/fapi/v1/listenKey");
    } catch {
      // listenKey may already be invalid
    }
    this.listenKey = undefined;
  }

  /** Close the live socket so reconnect runs. Does not mark the stream stopped. */
  injectDisconnect(): void {
    this.socket?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.listenKey = await this.createListenKey();
    const url = userStreamUrl(this.options.wsBase, this.listenKey);
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
    this.scheduleKeepalive();
  }

  private async createListenKey(): Promise<string> {
    const payload = await this.options.rest.apiKeyRequest(
      "POST",
      "/fapi/v1/listenKey",
    );
    if (
      payload === null ||
      typeof payload !== "object" ||
      !("listenKey" in payload) ||
      typeof payload.listenKey !== "string"
    ) {
      throw new Error("listenKey missing from POST /fapi/v1/listenKey");
    }
    return payload.listenKey;
  }

  private scheduleKeepalive(): void {
    this.clearKeepalive();
    const interval = this.options.keepaliveMs ?? LISTEN_KEY_KEEPALIVE_MS;
    this.keepaliveTimer = setInterval(() => {
      void this.keepalive();
    }, interval);
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer !== undefined) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
  }

  private async keepalive(): Promise<void> {
    try {
      await this.options.rest.apiKeyRequest("PUT", "/fapi/v1/listenKey");
    } catch (error) {
      if (
        error instanceof BinanceApiError &&
        error.code === INVALID_LISTEN_KEY
      ) {
        await this.recreate();
      }
    }
  }

  private async recreate(): Promise<void> {
    const previous = this.socket;
    this.socket = undefined;
    previous?.close();
    await this.connect();
  }

  private async onMessage(data: unknown): Promise<void> {
    const payload = parseJsonMessage(data);
    const eventType = eventTypeOf(payload);
    if (eventType === "ORDER_TRADE_UPDATE") {
      this.options.handlers.onOrder?.(
        mapOrderTradeUpdate(payload, this.options.strategyId ?? ""),
      );
      return;
    }
    if (eventType === "ACCOUNT_UPDATE") {
      this.account = applyAccountUpdate(this.account, payload);
      this.options.handlers.onAccount?.(this.account);
      return;
    }
    if (mapListenKeyExpired(payload)) {
      this.options.handlers.onListenKeyExpired?.();
      await this.recreate();
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
