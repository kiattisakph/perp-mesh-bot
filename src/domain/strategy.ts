import type { AccountState, FuturesPosition } from "./account";
import type { Candle, MarketTicker, OrderBook } from "./market";
import type { TradingOrder } from "./order";

export type StrategyLifecycle =
  | "CREATED"
  | "STARTING"
  | "RECONCILING"
  | "READY"
  | "RUNNING"
  | "DEGRADED"
  | "PAUSED"
  | "STOPPING"
  | "STOPPED";

export type RateLimitState = "NORMAL" | "DEGRADED" | "PAUSED";

export interface SymbolPrecision {
  tickSize: number;
  stepSize: number;
  marketStepSize?: number;
  minNotional: number;
  quantityPrecision: number;
  pricePrecision: number;
}

export interface StrategySnapshot {
  strategyId: string;
  instanceId: string;
  symbol: string;
  lifecycle: StrategyLifecycle;
  rateLimitState: RateLimitState;
  account: AccountState;
  position: FuturesPosition | null;
  openOrders: TradingOrder[];
  orderBook?: OrderBook;
  ticker?: MarketTicker;
  markPrice?: number;
  candles?: Candle[];
  precision: SymbolPrecision;
  now: number;
}

export interface StrategyLog {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  strategyId: string;
  instanceId: string;
  symbol: string;
  event: string;
  details?: Record<string, unknown>;
}
