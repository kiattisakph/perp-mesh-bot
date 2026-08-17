import { STRATEGY_NAMES, type StrategyName } from "../../config/schema";
import type { OrderRateBucket } from "./order-rate";
import type { OrphanOrder, PositionMismatch } from "./audit";

/** testing.md: soak is at least 24 hours and at most 72 hours. */
export const SOAK_MIN_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SOAK_MAX_WINDOW_MS = 72 * 60 * 60 * 1000;

export const SOAK_STRATEGIES: readonly StrategyName[] = STRATEGY_NAMES;

export type SoakChecklistInput = {
  strategyId: StrategyName;
  windowMs: number;
  elapsedMs: number;
  /** Tests inject a shorter bar so bun test does not wait 24h. Live soak uses 24h. */
  minWindowMs: number;
  wsDisconnects: number;
  orphanOrders: readonly OrphanOrder[];
  positionMismatches: readonly PositionMismatch[];
  timersOutstanding: number;
  orderRatePerMinute: readonly OrderRateBucket[];
  orderStorm: boolean;
  unboundedOrderRate: boolean;
  killSwitchCancelOnly: boolean;
  killSwitchFlatten: boolean;
  cancelAllOrdersCalls: number;
};

export type SoakChecklistResult = {
  passed: boolean;
  failed: string[];
  productionReady: false;
  items: {
    windowCompleted: boolean;
    multipleWsDisconnects: boolean;
    noOrphanOrders: boolean;
    noPositionMismatch: boolean;
    noTimerLeaks: boolean;
    noOrderStorm: boolean;
    killSwitchCancelOnly: boolean;
    killSwitchFlatten: boolean;
    ownedCancelsOnly: boolean;
  };
};

export function evaluateSoakChecklist(
  input: SoakChecklistInput,
): SoakChecklistResult {
  const items = {
    windowCompleted: input.elapsedMs >= input.minWindowMs,
    multipleWsDisconnects: input.wsDisconnects >= 2,
    noOrphanOrders: input.orphanOrders.length === 0,
    noPositionMismatch: input.positionMismatches.length === 0,
    noTimerLeaks: input.timersOutstanding === 0,
    noOrderStorm: !input.orderStorm && !input.unboundedOrderRate,
    killSwitchCancelOnly: input.killSwitchCancelOnly,
    killSwitchFlatten: input.killSwitchFlatten,
    ownedCancelsOnly: input.cancelAllOrdersCalls === 0,
  };
  const failed: string[] = [];
  if (input.windowMs < input.minWindowMs || input.windowMs > SOAK_MAX_WINDOW_MS) {
    failed.push("window_out_of_range");
  }
  if (!items.windowCompleted) {
    failed.push("window_incomplete");
  }
  if (!items.multipleWsDisconnects) {
    failed.push("ws_disconnects");
  }
  if (!items.noOrphanOrders) {
    failed.push("orphan_orders");
  }
  if (!items.noPositionMismatch) {
    failed.push("position_mismatch");
  }
  if (!items.noTimerLeaks) {
    failed.push("timer_leaks");
  }
  if (!items.noOrderStorm) {
    failed.push("order_storm");
  }
  if (!items.killSwitchCancelOnly) {
    failed.push("kill_switch_cancel_only");
  }
  if (!items.killSwitchFlatten) {
    failed.push("kill_switch_flatten");
  }
  if (!items.ownedCancelsOnly) {
    failed.push("symbol_wide_cancel");
  }
  return {
    passed: failed.length === 0,
    failed,
    productionReady: false,
    items,
  };
}
