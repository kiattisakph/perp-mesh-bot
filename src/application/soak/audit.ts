import type { AccountState, FuturesPosition } from "../../domain/account";
import type { TradingOrder } from "../../domain/order";
import { isFlat } from "../../domain/position";
import {
  isBotOwned,
  parseOwnedClientOrderId,
  type OrderOwnership,
} from "../ownership";

export type OrphanOrder = {
  clientOrderId: string;
  reason: "unexpected_owned" | "unparsed_owned";
};

export type PositionMismatch = {
  symbol: string;
  snapshotQuantity: number;
  exchangeQuantity: number;
};

function isLive(order: TradingOrder): boolean {
  return order.status === "NEW" || order.status === "PARTIALLY_FILLED";
}

function trackedIds(tracked: readonly TradingOrder[]): Set<string> {
  return new Set(tracked.map((order) => order.clientOrderId));
}

/**
 * Orphans are live bot-owned exchange orders this instance is not tracking,
 * or owned ids that do not parse. Foreign orders are not orphans.
 */
export function auditOrphanOrders(input: {
  trackedOrders: readonly TradingOrder[];
  exchangeOpenOrders: readonly TradingOrder[];
  ownership: OrderOwnership;
}): OrphanOrder[] {
  const known = trackedIds(input.trackedOrders);
  const orphans: OrphanOrder[] = [];
  for (const order of input.exchangeOpenOrders) {
    if (!isLive(order) || !isBotOwned(order.clientOrderId, input.ownership)) {
      continue;
    }
    if (parseOwnedClientOrderId(order.clientOrderId, input.ownership) === undefined) {
      orphans.push({
        clientOrderId: order.clientOrderId,
        reason: "unparsed_owned",
      });
      continue;
    }
    if (!known.has(order.clientOrderId)) {
      orphans.push({
        clientOrderId: order.clientOrderId,
        reason: "unexpected_owned",
      });
    }
  }
  return orphans;
}

export function positionQuantityOnAccount(
  account: AccountState,
  symbol: string,
): number {
  const row = account.positions.find((position) => position.symbol === symbol);
  return row === undefined ? 0 : row.quantity;
}

export function auditPositionMismatch(input: {
  symbol: string;
  snapshotPosition: FuturesPosition | null;
  exchangeAccount: AccountState;
}): PositionMismatch | undefined {
  const snapshotQuantity =
    input.snapshotPosition === null ? 0 : input.snapshotPosition.quantity;
  const exchangeQuantity = positionQuantityOnAccount(
    input.exchangeAccount,
    input.symbol,
  );
  if (snapshotQuantity === exchangeQuantity) {
    return undefined;
  }
  return {
    symbol: input.symbol,
    snapshotQuantity,
    exchangeQuantity,
  };
}

export function isExchangeFlat(account: AccountState, symbol: string): boolean {
  return isFlat(positionQuantityOnAccount(account, symbol));
}
