import type { FuturesPosition } from "../domain/account";
import type { OrderIntent, PlaceIntent } from "../domain/intent";
import { isEntryIntent, isPlaceIntent } from "../domain/intent";
import type { TradingOrder } from "../domain/order";
import { absQuantity, isFlat } from "../domain/position";
import {
  isBotOwned,
  parseOwnedClientOrderId,
  purposeOf,
  type OrderOwnership,
} from "./ownership";

export type ReconcileMatch = {
  side: PlaceIntent["side"];
  reduceOnly: boolean;
  price?: number;
  stopPrice?: number;
  quantity: number;
  purpose: string;
};

export type ReconcileDecision = {
  keep: TradingOrder[];
  cancelOwned: TradingOrder[];
  foreign: TradingOrder[];
  missingPlaces: PlaceIntent[];
  unprotectedPosition: boolean;
  allowEntry: boolean;
};

function isLive(order: TradingOrder): boolean {
  return order.status === "NEW" || order.status === "PARTIALLY_FILLED";
}

function matchesExpected(
  order: TradingOrder,
  expected: ReconcileMatch,
  ownership: OrderOwnership,
): boolean {
  if (!isBotOwned(order.clientOrderId, ownership)) {
    return false;
  }
  const parsed = parseOwnedClientOrderId(order.clientOrderId, ownership);
  if (parsed === undefined || parsed.purpose !== expected.purpose) {
    return false;
  }
  if (order.side !== expected.side || order.reduceOnly !== expected.reduceOnly) {
    return false;
  }
  if (expected.price !== undefined && order.price !== expected.price) {
    return false;
  }
  if (expected.stopPrice !== undefined && order.stopPrice !== expected.stopPrice) {
    return false;
  }
  if (order.quantity !== expected.quantity) {
    return false;
  }
  return true;
}

function matchFromIntent(intent: PlaceIntent): ReconcileMatch {
  return {
    side: intent.side,
    reduceOnly: intent.reduceOnly,
    quantity: intent.quantity,
    purpose: purposeOf(intent),
    ...(intent.type === "PLACE_LIMIT"
      ? { price: intent.price }
      : intent.type === "PLACE_STOP"
        ? { stopPrice: intent.stopPrice }
        : {}),
  };
}

function hasProtection(
  owned: readonly TradingOrder[],
  ownership: OrderOwnership,
): boolean {
  return owned.some((order) => {
    if (!order.reduceOnly || !isLive(order)) {
      return false;
    }
    const parsed = parseOwnedClientOrderId(order.clientOrderId, ownership);
    return (
      parsed?.purpose === "stop" ||
      parsed?.purpose === "trail" ||
      parsed?.purpose === "exit"
    );
  });
}

export function reconcile(input: {
  expectedIntents: readonly OrderIntent[];
  openOrders: readonly TradingOrder[];
  position: FuturesPosition | null;
  ownership: OrderOwnership;
  reconciling: boolean;
}): ReconcileDecision {
  const expectedPlaces = input.expectedIntents.filter(isPlaceIntent);
  const foreign: TradingOrder[] = [];
  const owned: TradingOrder[] = [];
  for (const order of input.openOrders) {
    if (!isLive(order)) {
      continue;
    }
    if (isBotOwned(order.clientOrderId, input.ownership)) {
      owned.push(order);
    } else {
      foreign.push(order);
    }
  }

  const keep: TradingOrder[] = [];
  const used = new Set<string>();
  const missingPlaces: PlaceIntent[] = [];

  for (const intent of expectedPlaces) {
    const expected = matchFromIntent(intent);
    const found = owned.find(
      (order) =>
        !used.has(order.clientOrderId) &&
        matchesExpected(order, expected, input.ownership),
    );
    if (found !== undefined) {
      used.add(found.clientOrderId);
      keep.push(found);
      continue;
    }
    if (!isEntryIntent(intent) || !input.reconciling) {
      missingPlaces.push(intent);
    }
  }

  const cancelOwned = owned.filter((order) => !used.has(order.clientOrderId));
  const position = input.position;
  const inPosition = position !== null && !isFlat(position.quantity);
  const unprotectedPosition =
    inPosition &&
    !hasProtection(keep, input.ownership) &&
    !missingPlaces.some((intent) => intent.reduceOnly);

  return {
    keep,
    cancelOwned,
    foreign,
    missingPlaces,
    unprotectedPosition,
    allowEntry: !input.reconciling,
  };
}

export function restartIntents(decision: ReconcileDecision, strategyId: string): OrderIntent[] {
  const intents: OrderIntent[] = [];
  if (decision.cancelOwned.length > 0) {
    intents.push({
      type: "CANCEL",
      strategyId,
      orderIds: decision.cancelOwned.map((order) => order.clientOrderId),
    });
  }
  for (const place of decision.missingPlaces) {
    if (isEntryIntent(place) && !decision.allowEntry) {
      continue;
    }
    intents.push(place);
  }
  return intents;
}

export function positionCoveredByOwnedStops(
  position: FuturesPosition | null,
  openOrders: readonly TradingOrder[],
  ownership: OrderOwnership,
): boolean {
  if (position === null || isFlat(position.quantity)) {
    return true;
  }
  const absPos = absQuantity(position.quantity);
  const covered = openOrders
    .filter(
      (order) =>
        isLive(order) &&
        order.reduceOnly &&
        isBotOwned(order.clientOrderId, ownership) &&
        (order.type === "STOP_MARKET" || order.type === "TRAILING_STOP_MARKET"),
    )
    .reduce((sum, order) => sum + order.quantity, 0);
  return covered > 0 && covered <= absPos;
}
