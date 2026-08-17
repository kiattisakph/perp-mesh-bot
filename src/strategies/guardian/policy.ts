import type { OrderIntent } from "../../domain/intent";
import type { TradingOrder } from "../../domain/order";
import { remainingQuantity } from "../../domain/order";
import { absQuantity, closeSide, isFlat } from "../../domain/position";
import {
  isSendableQuantity,
  roundCloseQuantity,
} from "../../domain/rounding";
import type { StrategySnapshot } from "../../domain/strategy";
import {
  isBotOwned,
  parseOwnedClientOrderId,
  type OrderOwnership,
} from "../../application/ownership";
import type { GuardianConfig } from "./config";
import {
  markUnrealizedPnl,
  profitLockStopPrice,
  roundProtectivePrice,
  trailingActivationPrice,
} from "./protection";
import type { GuardianPhase, GuardianState } from "./state";

export type GuardianResult = {
  intents: OrderIntent[];
  state: GuardianState;
};

function isLive(order: TradingOrder): boolean {
  return order.status === "NEW" || order.status === "PARTIALLY_FILLED";
}

function ownedLive(
  snapshot: StrategySnapshot,
  ownership: OrderOwnership,
): TradingOrder[] {
  return snapshot.openOrders.filter((order) => {
    if (order.symbol !== snapshot.symbol || !isLive(order)) {
      return false;
    }
    return isBotOwned(order.clientOrderId, ownership);
  });
}

function ownedPurpose(
  orders: readonly TradingOrder[],
  ownership: OrderOwnership,
  purpose: "stop" | "trail",
): TradingOrder[] {
  return orders.filter((order) => {
    if (!order.reduceOnly) {
      return false;
    }
    const parsed = parseOwnedClientOrderId(order.clientOrderId, ownership);
    return parsed?.purpose === purpose;
  });
}

function markFromSnapshot(snapshot: StrategySnapshot): number | undefined {
  if (snapshot.markPrice !== undefined && Number.isFinite(snapshot.markPrice)) {
    return snapshot.markPrice;
  }
  if (
    snapshot.ticker !== undefined &&
    Number.isFinite(snapshot.ticker.markPrice)
  ) {
    return snapshot.ticker.markPrice;
  }
  if (
    snapshot.position !== null &&
    Number.isFinite(snapshot.position.markPrice)
  ) {
    return snapshot.position.markPrice;
  }
  return undefined;
}

function samePrice(left: number, right: number): boolean {
  return left === right;
}

function cancelProtective(
  strategyId: string,
  orders: readonly TradingOrder[],
): OrderIntent[] {
  if (orders.length === 0) {
    return [];
  }
  return [
    {
      type: "CANCEL",
      strategyId,
      orderIds: orders.map((order) => order.clientOrderId),
    },
  ];
}

export function evaluateGuardian(input: {
  snapshot: StrategySnapshot;
  config: GuardianConfig;
  ownership: OrderOwnership;
}): GuardianResult {
  const { snapshot, config, ownership } = input;
  const position = snapshot.position;
  const owned = ownedLive(snapshot, ownership);
  const stops = ownedPurpose(owned, ownership, "stop");
  const trails = ownedPurpose(owned, ownership, "trail");
  const protective = [...stops, ...trails];

  if (position === null || isFlat(position.quantity)) {
    const intents = cancelProtective(snapshot.strategyId, protective);
    return {
      intents,
      state: { phase: intents.length > 0 ? "CLEANUP" : "IDLE" },
    };
  }

  const absPos = absQuantity(position.quantity);
  const quantity = roundCloseQuantity(absPos, absPos, snapshot.precision);
  const side = closeSide(position.quantity);
  let phase: GuardianPhase = stops.length === 0 ? "PENDING_PROTECTION" : "PROTECTING";
  const intents: OrderIntent[] = [];

  if (!isSendableQuantity(quantity)) {
    return { intents, state: { phase } };
  }

  const markPrice = markFromSnapshot(snapshot);
  const profit =
    markPrice === undefined
      ? 0
      : markUnrealizedPnl(position.entryPrice, markPrice, position.quantity);
  const rawStop = profitLockStopPrice({
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    lossUsd: config.lossLimitUsdt,
    profit,
    triggerUsd: config.profitLockTriggerUsdt,
    offsetUsd: config.profitLockStepUsdt,
  });
  const stopPrice = roundProtectivePrice(
    rawStop,
    position.quantity,
    snapshot.precision.tickSize,
  );
  const rawActivation = trailingActivationPrice({
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    trailingProfitUsd: config.trailingActivationProfitUsdt,
  });
  const activationPrice = roundProtectivePrice(
    rawActivation,
    position.quantity,
    snapshot.precision.tickSize,
  );

  const matchingStop = stops.find(
    (order) =>
      order.side === side &&
      order.type === "STOP_MARKET" &&
      order.stopPrice !== undefined &&
      samePrice(
        roundProtectivePrice(
          order.stopPrice,
          position.quantity,
          snapshot.precision.tickSize,
        ),
        stopPrice,
      ) &&
      remainingQuantity(order) <= absPos &&
      order.quantity === quantity,
  );
  const extraStops = stops.filter((order) => order !== matchingStop);
  if (extraStops.length > 0) {
    intents.push(...cancelProtective(snapshot.strategyId, extraStops));
    phase = matchingStop === undefined ? "MOVE_STOP" : phase;
  }
  if (matchingStop === undefined && stopPrice > 0) {
    intents.push({
      type: "PLACE_STOP",
      strategyId: snapshot.strategyId,
      symbol: snapshot.symbol,
      side,
      stopPrice,
      quantity,
      reduceOnly: true,
    });
    if (stops.length > 0) {
      phase = "MOVE_STOP";
    } else {
      phase = "PENDING_PROTECTION";
    }
  }

  const matchingTrail = trails.find(
    (order) =>
      order.side === side &&
      order.type === "TRAILING_STOP_MARKET" &&
      order.activationPrice !== undefined &&
      samePrice(
        roundProtectivePrice(
          order.activationPrice,
          position.quantity,
          snapshot.precision.tickSize,
        ),
        activationPrice,
      ) &&
      remainingQuantity(order) <= absPos &&
      order.quantity === quantity,
  );
  const extraTrails = trails.filter((order) => order !== matchingTrail);
  if (extraTrails.length > 0) {
    intents.push(...cancelProtective(snapshot.strategyId, extraTrails));
  }
  if (matchingTrail === undefined && activationPrice > 0) {
    intents.push({
      type: "PLACE_TRAILING_STOP",
      strategyId: snapshot.strategyId,
      symbol: snapshot.symbol,
      side,
      activationPrice,
      callbackRate: config.trailingCallbackRate,
      quantity,
      reduceOnly: true,
    });
  }

  return { intents, state: { phase } };
}

export function evaluateProtection(input: {
  snapshot: StrategySnapshot;
  config: GuardianConfig;
  ownership: OrderOwnership;
}): OrderIntent[] {
  return evaluateGuardian(input).intents;
}
