import type { PlaceIntent } from "../domain/intent";
import type { OrderSide, TradingOrder } from "../domain/order";

/**
 * App prefix is TBD in architecture.md (`bfu` is an origin example only).
 * `pmb` is this product's prefix so ownership is verifiable and not copied
 * from origin naming.
 */
export const CLIENT_ORDER_APP_PREFIX = "pmb";
export const CLIENT_ORDER_ID_MAX_LEN = 36;
export const CLIENT_ORDER_SEQUENCE_WIDTH = 6;

const CLIENT_ORDER_ID_PATTERN = /^[.A-Z:/a-z0-9_-]{1,36}$/;
const SEGMENT_PATTERN = /^[.A-Z:/a-z0-9_-]+$/;

/** Longest purpose used in clientOrderId (`entry` / `trail`). */
const MAX_PURPOSE_LEN = 5;

export type OrderPurpose = "entry" | "stop" | "trail" | "bid" | "ask" | "exit";

export type OrderOwnership = {
  appPrefix: string;
  strategyId: string;
  instanceId: string;
  instanceSegment: string;
  prefix: string;
};

export type DuplicateKey = {
  purpose: OrderPurpose;
  side: OrderSide;
};

export function purposeOf(intent: PlaceIntent): OrderPurpose {
  switch (intent.type) {
    case "PLACE_STOP":
      return "stop";
    case "PLACE_TRAILING_STOP":
      return "trail";
    case "PLACE_MARKET":
      return intent.reduceOnly ? "exit" : "entry";
    case "PLACE_LIMIT":
      if (intent.reduceOnly) {
        return "exit";
      }
      return intent.side === "BUY" ? "bid" : "ask";
  }
}

export function duplicateKeyOf(intent: PlaceIntent): DuplicateKey {
  return { purpose: purposeOf(intent), side: intent.side };
}

export function duplicateKeyEquals(a: DuplicateKey, b: DuplicateKey): boolean {
  return a.purpose === b.purpose && a.side === b.side;
}

function requireSegment(name: string, value: string): string {
  if (value.trim() === "" || !SEGMENT_PATTERN.test(value)) {
    throw new RangeError(`${name} must match Binance newClientOrderId charset`);
  }
  return value;
}

export function createOrderOwnership(input: {
  strategyId: string;
  instanceId: string;
  appPrefix?: string;
}): OrderOwnership {
  const appPrefix = requireSegment(
    "appPrefix",
    input.appPrefix ?? CLIENT_ORDER_APP_PREFIX,
  );
  const strategyId = requireSegment("strategyId", input.strategyId);
  const instanceId = requireSegment("instanceId", input.instanceId);
  const remainderMax =
    MAX_PURPOSE_LEN + 1 + CLIENT_ORDER_SEQUENCE_WIDTH;
  const maxPrefix = CLIENT_ORDER_ID_MAX_LEN - remainderMax;
  const withoutInstance = `${appPrefix}-${strategyId}-`;
  const maxInstance = maxPrefix - withoutInstance.length - 1;
  if (maxInstance < 1) {
    throw new RangeError(
      "clientOrderId prefix would exceed 36 characters before instance/purpose",
    );
  }
  const instanceSegment =
    instanceId.length > maxInstance
      ? instanceId.slice(0, maxInstance)
      : instanceId;
  return {
    appPrefix,
    strategyId,
    instanceId,
    instanceSegment,
    prefix: `${withoutInstance}${instanceSegment}-`,
  };
}

export function isBotOwned(
  clientOrderId: string,
  ownership: OrderOwnership,
): boolean {
  return clientOrderId.startsWith(ownership.prefix);
}

export function buildClientOrderId(input: {
  ownership: OrderOwnership;
  purpose: OrderPurpose;
  sequence: number;
}): string {
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new RangeError("sequence must be an integer >= 1");
  }
  const seq = String(input.sequence).padStart(CLIENT_ORDER_SEQUENCE_WIDTH, "0");
  const id = `${input.ownership.prefix}${input.purpose}-${seq}`;
  if (id.length > CLIENT_ORDER_ID_MAX_LEN || !CLIENT_ORDER_ID_PATTERN.test(id)) {
    throw new RangeError("clientOrderId exceeds 36 characters or charset");
  }
  return id;
}

export function parseOwnedClientOrderId(
  clientOrderId: string,
  ownership: OrderOwnership,
): { purpose: string; sequence: number } | undefined {
  if (!isBotOwned(clientOrderId, ownership)) {
    return undefined;
  }
  const rest = clientOrderId.slice(ownership.prefix.length);
  const dash = rest.lastIndexOf("-");
  if (dash <= 0) {
    return undefined;
  }
  const purpose = rest.slice(0, dash);
  const sequence = Number(rest.slice(dash + 1));
  if (purpose === "" || !Number.isInteger(sequence) || sequence < 1) {
    return undefined;
  }
  return { purpose, sequence };
}

export function nextClientOrderSequence(
  clientOrderIds: readonly string[],
  ownership: OrderOwnership,
): number {
  let max = 0;
  for (const id of clientOrderIds) {
    const parsed = parseOwnedClientOrderId(id, ownership);
    if (parsed !== undefined && parsed.sequence > max) {
      max = parsed.sequence;
    }
  }
  return max + 1;
}

function isLive(order: TradingOrder): boolean {
  return order.status === "NEW" || order.status === "PARTIALLY_FILLED";
}

export function ownedEntryClientOrderIds(
  openOrders: readonly TradingOrder[],
  ownership: OrderOwnership,
): string[] {
  return openOrders
    .filter((order) => {
      if (!isLive(order) || order.reduceOnly) {
        return false;
      }
      if (!isBotOwned(order.clientOrderId, ownership)) {
        return false;
      }
      const parsed = parseOwnedClientOrderId(order.clientOrderId, ownership);
      if (parsed === undefined) {
        return true;
      }
      return (
        parsed.purpose === "entry" ||
        parsed.purpose === "bid" ||
        parsed.purpose === "ask"
      );
    })
    .map((order) => order.clientOrderId);
}
