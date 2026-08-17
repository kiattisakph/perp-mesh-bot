import type { AccountState, FuturesPosition } from "../../src/domain/account";
import type { OrderIntent } from "../../src/domain/intent";
import { isPlaceIntent } from "../../src/domain/intent";
import type { TradingOrder } from "../../src/domain/order";
import type { SymbolPrecision } from "../../src/domain/strategy";
import type { ExecutionVenue } from "../../src/application/execution-venue";
import {
  RateLimitError,
  UnknownExecutionError,
} from "../../src/infrastructure/binance-usdm/errors";

export class FakeVenue implements ExecutionVenue {
  precision: SymbolPrecision | undefined;
  account: AccountState;
  orders = new Map<string, TradingOrder>();
  placeCalls: Array<{ intent: OrderIntent; clientOrderId: string }> = [];
  cancelCalls: Array<{ origClientOrderId?: string; orderId?: string }> = [];
  queryCalls = 0;
  fetchOpenOrdersCalls = 0;
  cancelAllOrdersCalls = 0;
  nextPlaceError: Error | undefined;
  nextCancelError: Error | undefined;
  private exchangeSeq = 1;

  constructor(input: {
    precision?: SymbolPrecision;
    account: AccountState;
    orders?: TradingOrder[];
  }) {
    this.precision = input.precision;
    this.account = input.account;
    for (const order of input.orders ?? []) {
      this.orders.set(order.clientOrderId, { ...order });
    }
  }

  loadedPrecision(): SymbolPrecision | undefined {
    return this.precision;
  }

  async fetchAccount(_symbol: string): Promise<AccountState> {
    return this.account;
  }

  async fetchOpenOrders(_symbol: string): Promise<TradingOrder[]> {
    this.fetchOpenOrdersCalls += 1;
    return [...this.orders.values()].filter(
      (order) => order.status === "NEW" || order.status === "PARTIALLY_FILLED",
    );
  }

  async placeFromIntent(
    intent: OrderIntent,
    newClientOrderId: string,
  ): Promise<TradingOrder> {
    this.placeCalls.push({ intent, clientOrderId: newClientOrderId });
    if (this.nextPlaceError !== undefined) {
      const error = this.nextPlaceError;
      this.nextPlaceError = undefined;
      throw error;
    }
    if (!isPlaceIntent(intent)) {
      throw new Error("not a place intent");
    }
    const order: TradingOrder = {
      exchangeOrderId: String(this.exchangeSeq),
      clientOrderId: newClientOrderId,
      strategyId: intent.strategyId,
      symbol: intent.symbol,
      side: intent.side,
      type:
        intent.type === "PLACE_LIMIT"
          ? "LIMIT"
          : intent.type === "PLACE_MARKET"
            ? "MARKET"
            : intent.type === "PLACE_STOP"
              ? "STOP_MARKET"
              : "TRAILING_STOP_MARKET",
      status: "NEW",
      quantity: intent.quantity,
      filledQuantity: 0,
      reduceOnly: intent.reduceOnly,
      updateTime: 1,
      ...(intent.type === "PLACE_LIMIT" ? { price: intent.price } : {}),
      ...(intent.type === "PLACE_STOP" ? { stopPrice: intent.stopPrice } : {}),
      ...(intent.type === "PLACE_TRAILING_STOP"
        ? { activationPrice: intent.activationPrice }
        : {}),
    };
    this.exchangeSeq += 1;
    this.orders.set(newClientOrderId, order);
    if (intent.type === "PLACE_MARKET") {
      order.status = "FILLED";
      order.filledQuantity = order.quantity;
      const existing = this.account.positions.find(
        (row) => row.symbol === intent.symbol,
      );
      if (intent.reduceOnly) {
        if (existing !== undefined) {
          existing.quantity = 0;
          existing.unrealizedPnl = 0;
        }
      } else {
        const delta = intent.side === "BUY" ? intent.quantity : -intent.quantity;
        if (existing === undefined) {
          this.account.positions.push({
            symbol: intent.symbol,
            quantity: delta,
            entryPrice: 100_000,
            markPrice: 100_000,
            unrealizedPnl: 0,
            leverage: 3,
            marginMode: "isolated",
            updateTime: 1,
          });
        } else {
          existing.quantity += delta;
        }
      }
    }
    return order;
  }

  async cancelOrder(input: {
    symbol: string;
    orderId?: string;
    origClientOrderId?: string;
  }): Promise<TradingOrder> {
    this.cancelCalls.push({
      origClientOrderId: input.origClientOrderId,
      orderId: input.orderId,
    });
    if (this.nextCancelError !== undefined) {
      const error = this.nextCancelError;
      this.nextCancelError = undefined;
      throw error;
    }
    const order = this.find(input.orderId, input.origClientOrderId);
    if (order === undefined) {
      throw new Error("unknown order");
    }
    order.status = "CANCELED";
    this.orders.set(order.clientOrderId, order);
    return order;
  }

  async queryOrder(input: {
    symbol: string;
    orderId?: string;
    origClientOrderId?: string;
  }): Promise<TradingOrder> {
    this.queryCalls += 1;
    const order = this.find(input.orderId, input.origClientOrderId);
    if (order === undefined) {
      throw new Error("unknown order");
    }
    return order;
  }

  cancelAllOrders(_symbol: string): void {
    this.cancelAllOrdersCalls += 1;
  }

  failNextPlace429(): void {
    this.nextPlaceError = new RateLimitError(429);
  }

  failNextPlaceUnknown(): void {
    this.nextPlaceError = new UnknownExecutionError();
  }

  failNextCancelUnknown(): void {
    this.nextCancelError = new Error("unknown cancel result");
  }

  setPosition(position: FuturesPosition): void {
    this.account = {
      ...this.account,
      positions: [
        ...this.account.positions.filter((row) => row.symbol !== position.symbol),
        position,
      ],
    };
  }

  private find(
    orderId: string | undefined,
    origClientOrderId: string | undefined,
  ): TradingOrder | undefined {
    if (origClientOrderId !== undefined) {
      const byClient = this.orders.get(origClientOrderId);
      if (byClient !== undefined) {
        return byClient;
      }
    }
    if (orderId !== undefined) {
      return [...this.orders.values()].find(
        (order) => order.exchangeOrderId === orderId,
      );
    }
    return undefined;
  }
}
