import type { AccountState, FuturesPosition } from "../domain/account";
import type { OrderIntent, PlaceIntent } from "../domain/intent";
import { isEntryIntent, isPlaceIntent } from "../domain/intent";
import type { TradingOrder } from "../domain/order";
import { absQuantity, closeSide, isFlat } from "../domain/position";
import {
  isSendableQuantity,
  meetsMinNotional,
  notional,
} from "../domain/rounding";
import type { RateLimitState, SymbolPrecision } from "../domain/strategy";
import { anyRequiredFeedStale, type FeedFreshness } from "../risk/freshness";
import { isMarkSlippageAllowed } from "../risk/slippage";
import {
  duplicateKeyEquals,
  duplicateKeyOf,
  isBotOwned,
  parseOwnedClientOrderId,
  type OrderOwnership,
} from "./ownership";

export type RiskRejectReason =
  | "stale_feed"
  | "rate_limit"
  | "kill_switch"
  | "max_position"
  | "max_notional"
  | "session_loss"
  | "slippage"
  | "duplicate"
  | "exit_not_reduce_only"
  | "zero_quantity"
  | "min_notional"
  | "unknown_precision"
  | "close_exceeds_position"
  | "not_owned_cancel"
  | "reconciling";

export type RejectedIntent = {
  intent: OrderIntent;
  reason: RiskRejectReason;
};

export type RiskLimits = {
  maxPositionQuantity: number;
  maxNotionalUsdt: number;
  maxCloseSlippageFraction: number;
  sessionLossLimitUsdt: number;
};

export type RiskContext = {
  symbol: string;
  ownership: OrderOwnership;
  precision: SymbolPrecision | undefined;
  position: FuturesPosition | null;
  account: AccountState;
  openOrders: TradingOrder[];
  inFlight: TradingOrder[];
  markPrice: number | undefined;
  closeCandidatePrice: number | undefined;
  rateLimitState: RateLimitState;
  freshness: FeedFreshness;
  killSwitchEngaged: boolean;
  lifecycleReconciling: boolean;
  sessionStartEquity: number;
  limits: RiskLimits;
  now: number;
};

export type RiskDecision = {
  allowed: OrderIntent[];
  rejected: RejectedIntent[];
};

function liveOrders(context: RiskContext): TradingOrder[] {
  return [...context.openOrders, ...context.inFlight].filter(
    (order) => order.status === "NEW" || order.status === "PARTIALLY_FILLED",
  );
}

function duplicateAgainstOrders(
  intent: PlaceIntent,
  orders: readonly TradingOrder[],
  ownership: OrderOwnership,
): boolean {
  const key = duplicateKeyOf(intent);
  return orders.some((order) => {
    if (!isBotOwned(order.clientOrderId, ownership)) {
      return false;
    }
    const parsed = parseOwnedClientOrderId(order.clientOrderId, ownership);
    return (
      parsed !== undefined &&
      parsed.purpose === key.purpose &&
      order.side === key.side
    );
  });
}

function sessionLossUsdt(context: RiskContext): number {
  const unrealized = context.account.positions.reduce(
    (sum, position) => sum + position.unrealizedPnl,
    0,
  );
  return context.sessionStartEquity - (context.account.walletBalance + unrealized);
}

function signedDelta(intent: PlaceIntent): number {
  return intent.side === "BUY" ? intent.quantity : -intent.quantity;
}

function wouldReducePosition(
  intent: PlaceIntent,
  position: FuturesPosition | null,
): boolean {
  if (position === null || isFlat(position.quantity)) {
    return false;
  }
  return intent.side === closeSide(position.quantity);
}

function placePrice(
  intent: PlaceIntent,
  markPrice: number | undefined,
): number | undefined {
  if (intent.type === "PLACE_LIMIT") {
    return intent.price;
  }
  if (intent.type === "PLACE_STOP") {
    return intent.stopPrice;
  }
  if (intent.type === "PLACE_TRAILING_STOP") {
    return intent.activationPrice;
  }
  return markPrice;
}

function ownedById(
  orderId: string,
  context: RiskContext,
): TradingOrder | undefined {
  return liveOrders(context).find(
    (order) =>
      isBotOwned(order.clientOrderId, context.ownership) &&
      (order.exchangeOrderId === orderId || order.clientOrderId === orderId),
  );
}

function evaluatePlace(
  intent: PlaceIntent,
  context: RiskContext,
  accepted: readonly PlaceIntent[],
): RiskRejectReason | undefined {
  if (context.precision === undefined) {
    return "unknown_precision";
  }
  if (!isSendableQuantity(intent.quantity)) {
    return "zero_quantity";
  }
  if (wouldReducePosition(intent, context.position) && !intent.reduceOnly) {
    return "exit_not_reduce_only";
  }
  if (intent.reduceOnly) {
    const absPos =
      context.position === null ? 0 : absQuantity(context.position.quantity);
    if (intent.quantity > absPos) {
      return "close_exceeds_position";
    }
  }

  const price = placePrice(intent, context.markPrice);
  if (
    price !== undefined &&
    !meetsMinNotional(intent.quantity, price, context.precision)
  ) {
    return "min_notional";
  }

  if (intent.type === "PLACE_MARKET" && intent.reduceOnly) {
    const candidate = context.closeCandidatePrice ?? context.markPrice;
    if (candidate === undefined || context.markPrice === undefined) {
      return "slippage";
    }
    if (
      !isMarkSlippageAllowed(
        candidate,
        context.markPrice,
        context.limits.maxCloseSlippageFraction,
      )
    ) {
      return "slippage";
    }
  }

  if (
    duplicateAgainstOrders(intent, liveOrders(context), context.ownership) ||
    accepted.some((prior) =>
      duplicateKeyEquals(duplicateKeyOf(prior), duplicateKeyOf(intent)),
    )
  ) {
    return "duplicate";
  }

  if (!isEntryIntent(intent)) {
    return undefined;
  }

  if (context.lifecycleReconciling) {
    return "reconciling";
  }
  if (context.killSwitchEngaged) {
    return "kill_switch";
  }
  if (context.rateLimitState !== "NORMAL") {
    return "rate_limit";
  }
  if (anyRequiredFeedStale(context.freshness)) {
    return "stale_feed";
  }
  if (sessionLossUsdt(context) >= context.limits.sessionLossLimitUsdt) {
    return "session_loss";
  }

  const currentQty = context.position?.quantity ?? 0;
  const nextQty = currentQty + signedDelta(intent);
  if (absQuantity(nextQty) > context.limits.maxPositionQuantity) {
    return "max_position";
  }
  const notionalPrice = price ?? context.markPrice;
  if (notionalPrice === undefined) {
    return "min_notional";
  }
  if (notional(nextQty, notionalPrice) > context.limits.maxNotionalUsdt) {
    return "max_notional";
  }
  return undefined;
}

export function filterIntents(
  intents: readonly OrderIntent[],
  context: RiskContext,
): RiskDecision {
  const allowed: OrderIntent[] = [];
  const rejected: RejectedIntent[] = [];
  const acceptedPlaces: PlaceIntent[] = [];

  for (const intent of intents) {
    if (intent.type === "CANCEL_OWNED") {
      allowed.push(intent);
      continue;
    }
    if (intent.type === "CANCEL") {
      const ownedIds = intent.orderIds.filter(
        (id) => ownedById(id, context) !== undefined,
      );
      if (ownedIds.length === 0) {
        rejected.push({ intent, reason: "not_owned_cancel" });
        continue;
      }
      allowed.push({ ...intent, orderIds: ownedIds });
      continue;
    }

    if (!isPlaceIntent(intent)) {
      continue;
    }
    const reason = evaluatePlace(intent, context, acceptedPlaces);
    if (reason !== undefined) {
      rejected.push({ intent, reason });
      continue;
    }
    allowed.push(intent);
    acceptedPlaces.push(intent);
  }

  return { allowed, rejected };
}
