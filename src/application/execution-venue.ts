import type { AccountState } from "../domain/account";
import type { OrderIntent } from "../domain/intent";
import type { TradingOrder } from "../domain/order";
import type { SymbolPrecision } from "../domain/strategy";

export type CancelOrderInput = {
  symbol: string;
  orderId?: string;
  origClientOrderId?: string;
};

export type QueryOrderInput = {
  symbol: string;
  orderId?: string;
  origClientOrderId?: string;
};

/**
 * Exchange operations used by execution. The Binance adapter satisfies this
 * structurally. Application code must not call symbol-wide cancel-all.
 */
export type ExecutionVenue = {
  placeFromIntent(
    intent: OrderIntent,
    newClientOrderId: string,
  ): Promise<TradingOrder>;
  cancelOrder(input: CancelOrderInput): Promise<TradingOrder>;
  queryOrder(input: QueryOrderInput): Promise<TradingOrder>;
  fetchOpenOrders(symbol: string): Promise<TradingOrder[]>;
  fetchAccount(symbol: string): Promise<AccountState>;
  loadedPrecision(): SymbolPrecision | undefined;
};
