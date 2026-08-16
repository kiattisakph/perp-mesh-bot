export type OrderSide = "BUY" | "SELL";

export type OrderType =
  | "LIMIT"
  | "MARKET"
  | "STOP_MARKET"
  | "TRAILING_STOP_MARKET";

export type OrderStatus =
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

export interface TradingOrder {
  exchangeOrderId: string;
  clientOrderId: string;
  strategyId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  price?: number;
  stopPrice?: number;
  activationPrice?: number;
  quantity: number;
  filledQuantity: number;
  reduceOnly: boolean;
  updateTime: number;
}

export function remainingQuantity(order: TradingOrder): number {
  return order.quantity - order.filledQuantity;
}
