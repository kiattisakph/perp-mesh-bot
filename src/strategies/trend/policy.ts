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
} from "../../domain/position";
import {
  ownedEntryClientOrderIds,
  type OrderOwnership,
} from "../../application/ownership";
import { bollingerBandwidth } from "../../indicators/bollinger";
import { sma } from "../../indicators/sma";
import { evaluateGuardian } from "../guardian/policy";
import { markUnrealizedPnl } from "../guardian/protection";
import type { GuardianConfig } from "../guardian/config";
import type { TrendConfig } from "./config";
import { initialTrendState, type TrendPhase, type TrendState } from "./state";

export type TrendResult = {
  intents: OrderIntent[];
  state: TrendState;
};

function closedCloses(candles: readonly Candle[] | undefined): number[] {
  if (candles === undefined) {
    return [];
  }
  return candles.filter((candle) => candle.closed).map((candle) => candle.close);
}

function lastClosedClose(candles: readonly Candle[] | undefined): number | undefined {
  const closes = closedCloses(candles);
  if (closes.length === 0) {
    return undefined;
  }
  return closes[closes.length - 1];
}

function signalPrice(snapshot: StrategySnapshot): number | undefined {
  const last = snapshot.ticker?.lastPrice;
  if (last === undefined || !Number.isFinite(last) || last <= 0) {
    return undefined;
  }
  return last;
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

export function sameUtcMinute(left: number, right: number): boolean {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate() &&
    a.getUTCHours() === b.getUTCHours() &&
    a.getUTCMinutes() === b.getUTCMinutes()
  );
}

function cooldownElapsed(
  lastStopAt: number | undefined,
  now: number,
  cooldownMs: number,
): boolean {
  if (lastStopAt === undefined) {
    return true;
  }
  return now - lastStopAt >= cooldownMs;
}

function entryAllowedLifecycle(lifecycle: StrategySnapshot["lifecycle"]): boolean {
  return lifecycle === "READY" || lifecycle === "RUNNING";
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

function protectionIntents(input: {
  snapshot: StrategySnapshot;
  config: GuardianConfig;
  ownership: OrderOwnership;
}): OrderIntent[] {
  return evaluateGuardian(input).intents;
}

function softLossClose(input: {
  snapshot: StrategySnapshot;
  config: TrendConfig;
}): OrderIntent | undefined {
  const { snapshot, config } = input;
  const position = snapshot.position;
  if (position === null || isFlat(position.quantity)) {
    return undefined;
  }
  const markPrice = markFromSnapshot(snapshot);
  if (markPrice === undefined) {
    return undefined;
  }
  const profit = markUnrealizedPnl(
    position.entryPrice,
    markPrice,
    position.quantity,
  );
  if (profit > -config.lossLimitUsdt) {
    return undefined;
  }
  const absPos = absQuantity(position.quantity);
  const quantity = roundCloseQuantity(
    absPos,
    absPos,
    snapshot.precision,
    "market",
  );
  if (!isSendableQuantity(quantity)) {
    return undefined;
  }
  return {
    type: "PLACE_MARKET",
    strategyId: snapshot.strategyId,
    symbol: snapshot.symbol,
    side: closeSide(position.quantity),
    quantity,
    reduceOnly: true,
    reason: "soft_loss",
  };
}

function inPositionPhase(lifecycle: StrategySnapshot["lifecycle"]): TrendPhase {
  return lifecycle === "RECONCILING" ? "PROTECTING" : "IN_POSITION";
}

function wasProtecting(phase: TrendPhase): boolean {
  return phase === "IN_POSITION" || phase === "PROTECTING";
}

function crossSide(
  previousPrice: number,
  currentPrice: number,
  smaValue: number,
): "long" | "short" | undefined {
  if (previousPrice < smaValue && currentPrice > smaValue) {
    return "long";
  }
  if (previousPrice > smaValue && currentPrice < smaValue) {
    return "short";
  }
  return undefined;
}

function entryIntent(input: {
  snapshot: StrategySnapshot;
  config: TrendConfig;
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
  return {
    type: "PLACE_MARKET",
    strategyId: snapshot.strategyId,
    symbol: snapshot.symbol,
    side: entrySide(side),
    quantity,
    reduceOnly: false,
    reason: "trend_entry",
  };
}

export function evaluateTrend(input: {
  snapshot: StrategySnapshot;
  config: TrendConfig;
  ownership: OrderOwnership;
  state?: TrendState;
}): TrendResult {
  const { snapshot, config, ownership } = input;
  const previous = input.state ?? initialTrendState();
  const currentPrice = signalPrice(snapshot);
  const crossPrevious =
    previous.previousPrice ?? lastClosedClose(snapshot.candles);
  const nextState: TrendState = { ...previous };
  if (currentPrice !== undefined) {
    nextState.previousPrice = currentPrice;
  } else if (
    nextState.previousPrice === undefined &&
    crossPrevious !== undefined
  ) {
    nextState.previousPrice = crossPrevious;
  }

  const position = snapshot.position;
  const hasPosition = position !== null && !isFlat(position.quantity);

  if (hasPosition) {
    if (!wasProtecting(previous.phase)) {
      nextState.lastEntryAt = nextState.lastEntryAt ?? snapshot.now;
    }
    nextState.phase = inPositionPhase(snapshot.lifecycle);
    const intents = [
      ...cancelLeftoverEntries(snapshot.strategyId, snapshot, ownership),
      ...protectionIntents({ snapshot, config, ownership }),
    ];
    const close = softLossClose({ snapshot, config });
    if (close !== undefined) {
      intents.push(close);
    }
    return { intents, state: nextState };
  }

  if (wasProtecting(previous.phase)) {
    nextState.lastStopAt = snapshot.now;
  }

  const leftover = ownedEntryClientOrderIds(snapshot.openOrders, ownership);
  if (leftover.length > 0) {
    const opening =
      previous.phase === "OPENING_LONG" || previous.phase === "OPENING_SHORT";
    if (opening) {
      nextState.phase = previous.phase;
      return { intents: [], state: nextState };
    }
    nextState.phase = "FLAT";
    return {
      intents: cancelLeftoverEntries(snapshot.strategyId, snapshot, ownership),
      state: nextState,
    };
  }

  if (
    currentPrice === undefined ||
    !entryAllowedLifecycle(snapshot.lifecycle) ||
    snapshot.rateLimitState !== "NORMAL" ||
    (previous.lastEntryAt !== undefined &&
      sameUtcMinute(previous.lastEntryAt, snapshot.now)) ||
    !cooldownElapsed(nextState.lastStopAt, snapshot.now, config.entryCooldownMs)
  ) {
    nextState.phase = "FLAT";
    return { intents: [], state: nextState };
  }

  const closes = closedCloses(snapshot.candles);
  const needed = Math.max(config.smaPeriod, config.bollingerLength);
  if (closes.length < needed) {
    nextState.phase = "FLAT";
    return { intents: [], state: nextState };
  }

  let smaValue: number;
  let bandwidth: number;
  try {
    smaValue = sma(closes, config.smaPeriod);
    bandwidth = bollingerBandwidth(
      closes,
      config.bollingerLength,
      config.bollingerMultiplier,
    );
  } catch {
    nextState.phase = "FLAT";
    return { intents: [], state: nextState };
  }

  if (bandwidth < config.minBandwidth) {
    nextState.phase = "FLAT";
    return { intents: [], state: nextState };
  }

  if (crossPrevious === undefined) {
    nextState.phase = "FLAT";
    return { intents: [], state: nextState };
  }

  const side = crossSide(crossPrevious, currentPrice, smaValue);
  if (side === undefined) {
    nextState.phase = "FLAT";
    return { intents: [], state: nextState };
  }

  const notionalPrice = markFromSnapshot(snapshot) ?? currentPrice;
  const intent = entryIntent({
    snapshot,
    config,
    side,
    price: notionalPrice,
  });
  if (intent === undefined) {
    nextState.phase = "FLAT";
    return { intents: [], state: nextState };
  }

  nextState.phase = side === "long" ? "OPENING_LONG" : "OPENING_SHORT";
  nextState.lastEntryAt = snapshot.now;
  return { intents: [intent], state: nextState };
}
