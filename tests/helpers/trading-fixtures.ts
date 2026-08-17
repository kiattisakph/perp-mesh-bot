import type { AccountState, FuturesPosition } from "../../src/domain/account";
import type { TradingOrder } from "../../src/domain/order";
import type { SymbolPrecision } from "../../src/domain/strategy";
import type { FeedFreshness } from "../../src/risk/freshness";
import {
  createOrderOwnership,
  type OrderOwnership,
} from "../../src/application/ownership";
import type { RiskContext, RiskLimits } from "../../src/application/risk-service";

export const btcPrecision: SymbolPrecision = {
  tickSize: 0.1,
  stepSize: 0.001,
  minNotional: 5,
  quantityPrecision: 3,
  pricePrecision: 1,
};

export const freshFeeds: FeedFreshness = {
  depthStale: false,
  userStreamStale: false,
  accountStale: false,
  marketStale: false,
};

export const defaultLimits: RiskLimits = {
  maxPositionQuantity: 0.002,
  maxNotionalUsdt: 200,
  maxCloseSlippageFraction: 0.005,
  sessionLossLimitUsdt: 10,
};

export function testOwnership(
  strategyId = "trend",
  instanceId = "a1",
): OrderOwnership {
  return createOrderOwnership({ strategyId, instanceId });
}

export function testAccount(
  position: FuturesPosition | null = null,
): AccountState {
  return {
    walletBalance: 1000,
    availableBalance: 900,
    positions: position === null ? [] : [position],
    updateTime: 1,
  };
}

export function longPosition(
  quantity = 0.001,
  entryPrice = 100_000,
): FuturesPosition {
  return {
    symbol: "BTCUSDT",
    quantity,
    entryPrice,
    markPrice: entryPrice,
    unrealizedPnl: 0,
    leverage: 3,
    marginMode: "isolated",
    updateTime: 1,
  };
}

export function testOrder(
  ownership: OrderOwnership,
  input: {
    purpose: string;
    sequence: number;
    side: TradingOrder["side"];
    type?: TradingOrder["type"];
    reduceOnly: boolean;
    quantity?: number;
    price?: number;
    stopPrice?: number;
    activationPrice?: number;
    status?: TradingOrder["status"];
    exchangeOrderId?: string;
    strategyId?: string;
    filledQuantity?: number;
    updateTime?: number;
  },
): TradingOrder {
  const order: TradingOrder = {
    exchangeOrderId: input.exchangeOrderId ?? String(input.sequence),
    clientOrderId: `${ownership.prefix}${input.purpose}-${String(input.sequence).padStart(6, "0")}`,
    strategyId: input.strategyId ?? ownership.strategyId,
    symbol: "BTCUSDT",
    side: input.side,
    type: input.type ?? "LIMIT",
    status: input.status ?? "NEW",
    quantity: input.quantity ?? 0.001,
    filledQuantity: input.filledQuantity ?? 0,
    reduceOnly: input.reduceOnly,
    updateTime: input.updateTime ?? 1,
  };
  if (input.price !== undefined) {
    order.price = input.price;
  }
  if (input.stopPrice !== undefined) {
    order.stopPrice = input.stopPrice;
  }
  if (input.activationPrice !== undefined) {
    order.activationPrice = input.activationPrice;
  }
  return order;
}

export function foreignOrder(): TradingOrder {
  return {
    exchangeOrderId: "99",
    clientOrderId: "manual-keep-me",
    strategyId: "other",
    symbol: "BTCUSDT",
    side: "BUY",
    type: "LIMIT",
    status: "NEW",
    price: 99_000,
    quantity: 0.001,
    filledQuantity: 0,
    reduceOnly: false,
    updateTime: 1,
  };
}

export function testRiskContext(
  ownership: OrderOwnership,
  overrides: Partial<RiskContext> = {},
): RiskContext {
  const account = overrides.account ?? testAccount();
  return {
    symbol: "BTCUSDT",
    ownership,
    precision: btcPrecision,
    position: null,
    account,
    openOrders: [],
    inFlight: [],
    markPrice: 100_000,
    closeCandidatePrice: 100_000,
    rateLimitState: "NORMAL",
    freshness: freshFeeds,
    killSwitchEngaged: false,
    lifecycleReconciling: false,
    sessionStartEquity: account.walletBalance,
    limits: defaultLimits,
    now: 1_000,
    ...overrides,
  };
}
