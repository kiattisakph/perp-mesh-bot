import type { OrderIntent } from "../../domain/intent";
import type { Candle } from "../../domain/market";
import {
  isSendableQuantity,
  meetsMinNotional,
  roundCloseQuantity,
  roundEntryQuantity,
} from "../../domain/rounding";
import type { StrategySnapshot } from "../../domain/strategy";
import {
  absQuantity,
  closeSide,
  entrySide,
  isFlat,
  isLong,
  isShort,
} from "../../domain/position";
import {
  isBotOwned,
  ownedEntryClientOrderIds,
  type OrderOwnership,
} from "../../application/ownership";
import { rsiFromClosedCloses } from "../../indicators/rsi";
import { percentStopPrice } from "../../risk/stop-loss";
import { markUnrealizedPnl, roundProtectivePrice } from "../guardian/protection";
import { directionAllows, type SwingConfig } from "./config";
import { initialSwingState, type SwingState } from "./state";

export type SwingResult = {
  intents: OrderIntent[];
  state: SwingState;
};

function closedCloses(candles: readonly Candle[] | undefined): number[] {
  if (candles === undefined) {
    return [];
  }
  return candles.filter((candle) => candle.closed).map((candle) => candle.close);
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

function entryAllowedLifecycle(lifecycle: StrategySnapshot["lifecycle"]): boolean {
  return lifecycle === "READY" || lifecycle === "RUNNING";
}

function crossedUpThrough(
  previous: number,
  current: number,
  level: number,
): boolean {
  return previous < level && current >= level;
}

function crossedDownThrough(
  previous: number,
  current: number,
  level: number,
): boolean {
  return previous > level && current <= level;
}

function cancelLeftoverEntries(
  strategyId: string,
  snapshot: StrategySnapshot,
  ownership: OrderOwnership,
): OrderIntent[] {
  const leftover = ownedEntryClientOrderIds(snapshot.openOrders, ownership);
  if (leftover.length === 0) {
    return [];
  }
  return [{ type: "CANCEL", strategyId, orderIds: leftover }];
}

function closeQuantity(
  snapshot: StrategySnapshot,
  absPos: number,
): number | undefined {
  const quantity = roundCloseQuantity(
    absPos,
    absPos,
    snapshot.precision,
    "market",
  );
  if (!isSendableQuantity(quantity)) {
    return undefined;
  }
  return quantity;
}

function swingStopPrice(
  snapshot: StrategySnapshot,
  config: SwingConfig,
): number | undefined {
  const position = snapshot.position;
  if (position === null || isFlat(position.quantity)) {
    return undefined;
  }
  const raw = percentStopPrice({
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    stopLossFraction: config.stopLossFraction,
  });
  return roundProtectivePrice(
    raw,
    position.quantity,
    snapshot.precision.tickSize,
  );
}

function stopBreached(
  snapshot: StrategySnapshot,
  stopPrice: number,
): boolean {
  const markPrice = markFromSnapshot(snapshot);
  if (markPrice === undefined) {
    return false;
  }
  const position = snapshot.position;
  if (position === null || isFlat(position.quantity)) {
    return false;
  }
  if (isLong(position.quantity)) {
    return markPrice <= stopPrice;
  }
  return markPrice >= stopPrice;
}

/**
 * swing.md TBD: profit is only "profit condition".
 * Uses mark unrealized PnL > 0 USDT, the same mark formula as Guardian.
 * Fees are not in the domain model.
 */
function hasProfit(snapshot: StrategySnapshot): boolean {
  const position = snapshot.position;
  if (position === null || isFlat(position.quantity)) {
    return false;
  }
  const markPrice = markFromSnapshot(snapshot);
  if (markPrice === undefined) {
    return false;
  }
  return (
    markUnrealizedPnl(position.entryPrice, markPrice, position.quantity) > 0
  );
}

function signalExitAllowed(
  snapshot: StrategySnapshot,
  config: SwingConfig,
): boolean {
  if (!config.requireProfitForExit) {
    return true;
  }
  return hasProfit(snapshot);
}

function marketClose(
  snapshot: StrategySnapshot,
  quantity: number,
  reason: string,
): OrderIntent {
  const position = snapshot.position;
  if (position === null || isFlat(position.quantity)) {
    throw new RangeError("market close requires a position");
  }
  return {
    type: "PLACE_MARKET",
    strategyId: snapshot.strategyId,
    symbol: snapshot.symbol,
    side: closeSide(position.quantity),
    quantity,
    reduceOnly: true,
    reason,
  };
}

function matchingPercentStop(
  snapshot: StrategySnapshot,
  ownership: OrderOwnership,
  stopPrice: number,
  quantity: number,
  side: "BUY" | "SELL",
) {
  return snapshot.openOrders.find((order) => {
    if (order.symbol !== snapshot.symbol) {
      return false;
    }
    if (order.status !== "NEW" && order.status !== "PARTIALLY_FILLED") {
      return false;
    }
    if (!order.reduceOnly || order.type !== "STOP_MARKET") {
      return false;
    }
    if (order.side !== side || order.stopPrice !== stopPrice) {
      return false;
    }
    if (order.quantity !== quantity) {
      return false;
    }
    return isBotOwned(order.clientOrderId, ownership);
  });
}

function ownedLiveStops(
  snapshot: StrategySnapshot,
  ownership: OrderOwnership,
) {
  return snapshot.openOrders.filter((order) => {
    if (order.symbol !== snapshot.symbol) {
      return false;
    }
    if (order.status !== "NEW" && order.status !== "PARTIALLY_FILLED") {
      return false;
    }
    if (!order.reduceOnly || order.type !== "STOP_MARKET") {
      return false;
    }
    return isBotOwned(order.clientOrderId, ownership);
  });
}

function protectionIntents(input: {
  snapshot: StrategySnapshot;
  config: SwingConfig;
  ownership: OrderOwnership;
}): OrderIntent[] {
  const { snapshot, config, ownership } = input;
  const position = snapshot.position;
  if (position === null || isFlat(position.quantity)) {
    const stops = ownedLiveStops(snapshot, ownership);
    if (stops.length === 0) {
      return [];
    }
    return [
      {
        type: "CANCEL",
        strategyId: snapshot.strategyId,
        orderIds: stops.map((order) => order.clientOrderId),
      },
    ];
  }
  const absPos = absQuantity(position.quantity);
  const quantity = closeQuantity(snapshot, absPos);
  const stopPrice = swingStopPrice(snapshot, config);
  if (quantity === undefined || stopPrice === undefined || stopPrice <= 0) {
    return [];
  }
  const side = closeSide(position.quantity);
  const matching = matchingPercentStop(
    snapshot,
    ownership,
    stopPrice,
    quantity,
    side,
  );
  const extras = ownedLiveStops(snapshot, ownership).filter(
    (order) => order !== matching,
  );
  const intents: OrderIntent[] = [];
  if (extras.length > 0) {
    intents.push({
      type: "CANCEL",
      strategyId: snapshot.strategyId,
      orderIds: extras.map((order) => order.clientOrderId),
    });
  }
  if (matching === undefined) {
    intents.push({
      type: "PLACE_STOP",
      strategyId: snapshot.strategyId,
      symbol: snapshot.symbol,
      side,
      stopPrice,
      quantity,
      reduceOnly: true,
    });
  }
  return intents;
}

function entryIntent(input: {
  snapshot: StrategySnapshot;
  config: SwingConfig;
  side: "long" | "short";
  price: number;
}): OrderIntent | undefined {
  const { snapshot, config, side, price } = input;
  const quantity = roundEntryQuantity(
    config.tradeQuantity,
    snapshot.precision,
    "market",
  );
  if (!isSendableQuantity(quantity)) {
    return undefined;
  }
  if (!meetsMinNotional(quantity, price, snapshot.precision)) {
    return undefined;
  }
  // swing.md TBD: LIMIT vs MARKET for entry. Trend entries are PLACE_MARKET;
  // Swing signal/stop closes are also market. LIMIT would need an unspecified price.
  return {
    type: "PLACE_MARKET",
    strategyId: snapshot.strategyId,
    symbol: snapshot.symbol,
    side: entrySide(side),
    quantity,
    reduceOnly: false,
    reason: "swing_entry",
  };
}

function applyRsiArms(input: {
  state: SwingState;
  previousRsi: number | null;
  rsi: number;
  config: SwingConfig;
  inPosition: boolean;
  longPosition: boolean;
  shortPosition: boolean;
}): SwingState {
  const { state, previousRsi, rsi, config } = input;
  const next: SwingState = { ...state, previousRsi: rsi };
  if (previousRsi === null) {
    return next;
  }
  if (!input.inPosition) {
    next.armedShortExit = false;
    next.armedLongExit = false;
    if (
      directionAllows(config.direction, "short") &&
      crossedUpThrough(previousRsi, rsi, config.rsiHigh)
    ) {
      next.armedShortEntry = true;
    }
    if (
      directionAllows(config.direction, "long") &&
      crossedDownThrough(previousRsi, rsi, config.rsiLow)
    ) {
      next.armedLongEntry = true;
    }
    return next;
  }
  next.armedShortEntry = false;
  next.armedLongEntry = false;
  if (
    input.shortPosition &&
    crossedDownThrough(previousRsi, rsi, config.rsiLow)
  ) {
    next.armedShortExit = true;
  }
  if (
    input.longPosition &&
    crossedUpThrough(previousRsi, rsi, config.rsiHigh)
  ) {
    next.armedLongExit = true;
  }
  return next;
}

export function evaluateSwing(input: {
  snapshot: StrategySnapshot;
  config: SwingConfig;
  ownership: OrderOwnership;
  state?: SwingState;
}): SwingResult {
  const { snapshot, config, ownership } = input;
  const previous = input.state ?? initialSwingState();
  const rsi = rsiFromClosedCloses(closedCloses(snapshot.candles), config.rsiPeriod);
  const position = snapshot.position;
  const hasPosition = position !== null && !isFlat(position.quantity);
  const longPosition = hasPosition && position !== null && isLong(position.quantity);
  const shortPosition =
    hasPosition && position !== null && isShort(position.quantity);

  const nextState =
    rsi === null
      ? { ...previous }
      : applyRsiArms({
          state: previous,
          previousRsi: previous.previousRsi,
          rsi,
          config,
          inPosition: hasPosition,
          longPosition,
          shortPosition,
        });

  if (hasPosition) {
    const intents = [
      ...cancelLeftoverEntries(snapshot.strategyId, snapshot, ownership),
      ...protectionIntents({ snapshot, config, ownership }),
    ];
    const absPos = absQuantity(position.quantity);
    const quantity = closeQuantity(snapshot, absPos);
    const stopPrice = swingStopPrice(snapshot, config);
    if (
      quantity !== undefined &&
      stopPrice !== undefined &&
      stopBreached(snapshot, stopPrice)
    ) {
      intents.push(marketClose(snapshot, quantity, "swing_stop"));
      return { intents, state: nextState };
    }
    const currentRsi = nextState.previousRsi;
    if (quantity !== undefined && currentRsi !== null) {
      const shortExit =
        shortPosition &&
        nextState.armedShortExit &&
        currentRsi > config.rsiLow;
      const longExit =
        longPosition &&
        nextState.armedLongExit &&
        currentRsi < config.rsiHigh;
      if ((shortExit || longExit) && signalExitAllowed(snapshot, config)) {
        intents.push(marketClose(snapshot, quantity, "swing_signal_exit"));
      }
    }
    return { intents, state: nextState };
  }

  const leftover = ownedEntryClientOrderIds(snapshot.openOrders, ownership);
  const currentRsi = nextState.previousRsi;
  const wantShort =
    currentRsi !== null &&
    nextState.armedShortEntry &&
    currentRsi < config.rsiHigh &&
    directionAllows(config.direction, "short");
  const wantLong =
    currentRsi !== null &&
    nextState.armedLongEntry &&
    currentRsi > config.rsiLow &&
    directionAllows(config.direction, "long");

  if (leftover.length > 0) {
    if (wantShort || wantLong) {
      return { intents: [], state: nextState };
    }
    return {
      intents: cancelLeftoverEntries(snapshot.strategyId, snapshot, ownership),
      state: nextState,
    };
  }

  if (
    rsi === null ||
    currentRsi === null ||
    !entryAllowedLifecycle(snapshot.lifecycle) ||
    snapshot.rateLimitState !== "NORMAL"
  ) {
    return { intents: [], state: nextState };
  }

  if (wantShort && wantLong) {
    return { intents: [], state: nextState };
  }

  const side = wantShort ? "short" : wantLong ? "long" : undefined;
  if (side === undefined) {
    return { intents: [], state: nextState };
  }

  const price = markFromSnapshot(snapshot);
  if (price === undefined) {
    return { intents: [], state: nextState };
  }
  const intent = entryIntent({ snapshot, config, side, price });
  if (intent === undefined) {
    return { intents: [], state: nextState };
  }
  return { intents: [intent], state: nextState };
}
