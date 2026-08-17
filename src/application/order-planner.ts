import type { OrderIntent } from "../domain/intent";
import type { OrderSide, TradingOrder } from "../domain/order";
import {
  isBotOwned,
  parseOwnedClientOrderId,
  type OrderOwnership,
  type OrderPurpose,
} from "./ownership";

export type DesiredQuote = {
  purpose: "ENTRY_BID" | "ENTRY_ASK" | "EXIT";
  side: OrderSide;
  price: number;
  quantity: number;
  reduceOnly: boolean;
  postOnly: boolean;
};

export type PlannerMatch = {
  side: OrderSide;
  reduceOnly: boolean;
  price: number;
  quantity: number;
  purpose: OrderPurpose;
};

/**
 * Quantity-drift tolerance is TBD in architecture.md / maker-family.md.
 * Phase 4 treats any quantity difference as drift (tolerance 0).
 */
export const QUANTITY_DRIFT_TOLERANCE = 0;

const QUOTE_PURPOSE: Record<DesiredQuote["purpose"], OrderPurpose> = {
  ENTRY_BID: "bid",
  ENTRY_ASK: "ask",
  EXIT: "exit",
};

export function desiredToMatch(quote: DesiredQuote): PlannerMatch {
  return {
    side: quote.side,
    reduceOnly: quote.reduceOnly,
    price: quote.price,
    quantity: quote.quantity,
    purpose: QUOTE_PURPOSE[quote.purpose],
  };
}

export function orderMatchesDesired(
  order: TradingOrder,
  desired: PlannerMatch,
  ownership: OrderOwnership,
): boolean {
  if (!isBotOwned(order.clientOrderId, ownership)) {
    return false;
  }
  const parsed = parseOwnedClientOrderId(order.clientOrderId, ownership);
  if (parsed === undefined || parsed.purpose !== desired.purpose) {
    return false;
  }
  if (order.side !== desired.side) {
    return false;
  }
  if (order.reduceOnly !== desired.reduceOnly) {
    return false;
  }
  if (order.price !== desired.price) {
    return false;
  }
  if (Math.abs(order.quantity - desired.quantity) > QUANTITY_DRIFT_TOLERANCE) {
    return false;
  }
  return true;
}

function liveOwned(
  openOrders: readonly TradingOrder[],
  ownership: OrderOwnership,
): TradingOrder[] {
  return openOrders.filter(
    (order) =>
      (order.status === "NEW" || order.status === "PARTIALLY_FILLED") &&
      isBotOwned(order.clientOrderId, ownership),
  );
}

function quoteIntent(
  quote: DesiredQuote,
  strategyId: string,
  symbol: string,
): OrderIntent {
  return {
    type: "PLACE_LIMIT",
    strategyId,
    symbol,
    side: quote.side,
    price: quote.price,
    quantity: quote.quantity,
    postOnly: quote.postOnly,
    reduceOnly: quote.reduceOnly,
  };
}

export function planQuoteIntents(input: {
  desired: readonly DesiredQuote[];
  openOrders: readonly TradingOrder[];
  ownership: OrderOwnership;
  strategyId: string;
  symbol: string;
}): OrderIntent[] {
  const owned = liveOwned(input.openOrders, input.ownership);
  const used = new Set<string>();
  const intents: OrderIntent[] = [];
  const seenPurpose = new Set<string>();

  for (const quote of input.desired) {
    const purpose = QUOTE_PURPOSE[quote.purpose];
    if (seenPurpose.has(purpose)) {
      continue;
    }
    seenPurpose.add(purpose);

    const match = desiredToMatch(quote);
    const existing = owned.find(
      (order) =>
        !used.has(order.clientOrderId) &&
        orderMatchesDesired(order, match, input.ownership),
    );
    if (existing !== undefined) {
      used.add(existing.clientOrderId);
      continue;
    }

    const samePurpose = owned.find((order) => {
      if (used.has(order.clientOrderId)) {
        return false;
      }
      const parsed = parseOwnedClientOrderId(
        order.clientOrderId,
        input.ownership,
      );
      return parsed?.purpose === purpose;
    });
    if (samePurpose !== undefined) {
      used.add(samePurpose.clientOrderId);
      intents.push({
        type: "CANCEL",
        strategyId: input.strategyId,
        orderIds: [samePurpose.clientOrderId],
      });
    }
    intents.push(quoteIntent(quote, input.strategyId, input.symbol));
  }

  for (const order of owned) {
    if (used.has(order.clientOrderId)) {
      continue;
    }
    intents.push({
      type: "CANCEL",
      strategyId: input.strategyId,
      orderIds: [order.clientOrderId],
    });
  }

  return intents;
}
