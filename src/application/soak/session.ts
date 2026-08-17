import type { KillSwitchMode, StrategyName } from "../../config/schema";
import type { FuturesPosition } from "../../domain/account";
import type { OrderIntent } from "../../domain/intent";
import type { TradingOrder } from "../../domain/order";
import type { StrategySnapshot } from "../../domain/strategy";
import { RateLimitError } from "../../infrastructure/binance-usdm/errors";
import { killSwitchIntents } from "../../risk/kill-switch";
import { ExecutionService } from "../execution-service";
import type { ExecutionVenue } from "../execution-venue";
import {
  isBotOwned,
  ownedEntryClientOrderIds,
  type OrderOwnership,
} from "../ownership";
import {
  auditOrphanOrders,
  auditPositionMismatch,
  isExchangeFlat,
  type OrphanOrder,
  type PositionMismatch,
} from "./audit";
import {
  evaluateSoakChecklist,
  SOAK_MAX_WINDOW_MS,
  SOAK_MIN_WINDOW_MS,
  type SoakChecklistResult,
} from "./checklist";
import { leakSnapshot, type SoakClock } from "./leaks";
import { OrderRateTracker } from "./order-rate";

export type SoakStreamChaos = {
  injectPublicDisconnect(): void;
  injectUserDisconnect(): void;
};

export type SoakWsState = "connected" | "disconnected" | "reconnecting";

export type SoakMetrics = {
  wsConnectionState: SoakWsState;
  lastFeedUpdateAgeMs: number | undefined;
  restLatencyMs: number | undefined;
  restWsErrorCount: number;
  orderCreateCount: number;
  orderCancelCount: number;
  rateLimit429Count: number;
  openOrderCount: number;
  positionQuantity: number;
  positionNotional: number | undefined;
  realizedPnl: number | undefined;
  unrealizedPnl: number | undefined;
  strategyState: string;
  protectiveCoverage: boolean;
  reconciliationMismatch: number;
  killSwitchCount: number;
};

export type SoakReport = {
  strategyId: StrategyName;
  instanceId: string;
  symbol: string;
  elapsedMs: number;
  windowMs: number;
  wsDisconnects: number;
  orphanOrders: OrphanOrder[];
  positionMismatches: PositionMismatch[];
  timersOutstanding: number;
  heapUsedBytes: number;
  killSwitchCancelOnly: boolean;
  killSwitchFlatten: boolean;
  flattenReduceOnly: boolean;
  cancelAllOrdersCalls: number;
  metrics: SoakMetrics;
  checklist: SoakChecklistResult;
  productionReady: false;
};

export type SoakSessionOptions = {
  strategyId: StrategyName;
  instanceId: string;
  symbol: string;
  ownership: OrderOwnership;
  venue: ExecutionVenue;
  execution: ExecutionService;
  chaos: SoakStreamChaos;
  clock: SoakClock;
  windowMs: number;
  tickMs: number;
  minWindowMs?: number;
  disconnectAtMs: readonly number[];
  killSwitchCancelOnlyAtMs: number;
  killSwitchFlattenAtMs: number;
  maxCloseSlippageFraction: number;
  policy: (snapshot: StrategySnapshot) => OrderIntent[];
  snapshot: () => StrategySnapshot;
  strategyState?: () => string;
  lastFeedEventTime?: () => number | undefined;
  stoppables?: ReadonlyArray<{ stop: () => void | Promise<void> }>;
  cancelAllOrdersCalls?: () => number;
};

function liveOwned(
  orders: readonly TradingOrder[],
  ownership: OrderOwnership,
): TradingOrder[] {
  return orders.filter(
    (order) =>
      (order.status === "NEW" || order.status === "PARTIALLY_FILLED") &&
      isBotOwned(order.clientOrderId, ownership),
  );
}

function recordExecution(
  rate: OrderRateTracker,
  placed: number,
  canceled: number,
  now: number,
): void {
  if (placed > 0) {
    rate.recordPlace(now, placed);
  }
  if (canceled > 0) {
    rate.recordCancel(now, canceled);
  }
}

function applyExecutionToTracked(
  tracked: TradingOrder[],
  placed: readonly TradingOrder[],
  canceled: readonly TradingOrder[],
): TradingOrder[] {
  const canceledIds = new Set(canceled.map((order) => order.clientOrderId));
  const kept = tracked.filter(
    (order) =>
      !canceledIds.has(order.clientOrderId) &&
      (order.status === "NEW" || order.status === "PARTIALLY_FILLED"),
  );
  const known = new Set(kept.map((order) => order.clientOrderId));
  for (const order of placed) {
    if (
      (order.status === "NEW" || order.status === "PARTIALLY_FILLED") &&
      !known.has(order.clientOrderId)
    ) {
      kept.push(order);
      known.add(order.clientOrderId);
    }
  }
  return kept;
}

async function drillKillSwitch(input: {
  mode: KillSwitchMode;
  snapshot: StrategySnapshot;
  options: SoakSessionOptions;
  rate: OrderRateTracker;
  tracked: TradingOrder[];
  now: number;
}): Promise<{
  flattenReduceOnly: boolean;
  flatConfirmed: boolean;
  tracked: TradingOrder[];
}> {
  const { mode, snapshot, options, rate, now } = input;
  const intents = killSwitchIntents(mode, {
    symbol: options.symbol,
    strategyId: options.strategyId,
    position: snapshot.position,
    entryClientOrderIds: ownedEntryClientOrderIds(
      snapshot.openOrders,
      options.ownership,
    ),
    precision: snapshot.precision,
    markPrice: snapshot.markPrice,
    closeCandidatePrice: snapshot.markPrice,
    maxCloseSlippageFraction: options.maxCloseSlippageFraction,
  });
  let flattenReduceOnly = true;
  for (const intent of intents) {
    if (intent.type === "PLACE_MARKET" && intent.reduceOnly !== true) {
      flattenReduceOnly = false;
    }
  }
  const openOrders = await options.venue.fetchOpenOrders(options.symbol);
  const result = await options.execution.execute(intents, {
    symbol: options.symbol,
    ownership: options.ownership,
    openOrders,
  });
  recordExecution(rate, result.placed.length, result.canceled.length, now);
  const tracked = applyExecutionToTracked(
    input.tracked,
    result.placed,
    result.canceled,
  );
  if (mode !== "CANCEL_AND_FLATTEN") {
    return { flattenReduceOnly, flatConfirmed: true, tracked };
  }
  const account = await options.venue.fetchAccount(options.symbol);
  return {
    flattenReduceOnly,
    flatConfirmed: isExchangeFlat(account, options.symbol),
    tracked,
  };
}

export async function runSoakSession(
  options: SoakSessionOptions,
): Promise<SoakReport> {
  const minWindowMs = options.minWindowMs ?? SOAK_MIN_WINDOW_MS;
  if (options.tickMs <= 0) {
    throw new RangeError("tickMs must be greater than 0");
  }
  if (options.windowMs < minWindowMs || options.windowMs > SOAK_MAX_WINDOW_MS) {
    throw new RangeError(
      `soak windowMs must be between ${minWindowMs} and ${SOAK_MAX_WINDOW_MS}`,
    );
  }
  if (options.disconnectAtMs.length < 2) {
    throw new RangeError("soak requires multiple injected WS disconnects");
  }

  const started = options.clock.now();
  const end = started + options.windowMs;
  const rate = new OrderRateTracker();
  let tracked = options
    .snapshot()
    .openOrders.filter(
      (order) => order.status === "NEW" || order.status === "PARTIALLY_FILLED",
    );
  let orphans: OrphanOrder[] = [];
  let mismatches: PositionMismatch[] = [];
  let wsDisconnects = 0;
  let wsState: SoakWsState = "connected";
  let restWsErrorCount = 0;
  let killSwitchCount = 0;
  let killSwitchCancelOnly = false;
  let killSwitchFlatten = false;
  let flattenReduceOnly = true;
  let lastFeedAge: number | undefined;
  let restLatencyMs: number | undefined;
  let killSwitchEngaged = false;

  const auditNow = async (snapshot: StrategySnapshot): Promise<void> => {
    const restStarted = options.clock.now();
    const account = await options.venue.fetchAccount(options.symbol);
    const openOrders = await options.venue.fetchOpenOrders(options.symbol);
    restLatencyMs = options.clock.now() - restStarted;
    orphans = auditOrphanOrders({
      trackedOrders: [...tracked, ...options.execution.inFlightOrders()],
      exchangeOpenOrders: openOrders,
      ownership: options.ownership,
    });
    const mismatch = auditPositionMismatch({
      symbol: options.symbol,
      snapshotPosition: snapshot.position,
      exchangeAccount: account,
    });
    mismatches = mismatch === undefined ? [] : [mismatch];
  };

  let nextTick = started;
  const disconnectDue = [...options.disconnectAtMs].sort((a, b) => a - b);
  let disconnectIndex = 0;

  while (options.clock.now() <= end) {
    const now = options.clock.now();
    const elapsed = now - started;

    while (
      disconnectIndex < disconnectDue.length &&
      elapsed >= disconnectDue[disconnectIndex]!
    ) {
      wsState = "disconnected";
      if (disconnectIndex % 2 === 0) {
        options.chaos.injectPublicDisconnect();
      } else {
        options.chaos.injectUserDisconnect();
      }
      wsDisconnects += 1;
      disconnectIndex += 1;
      wsState = "connected";
    }

    if (!killSwitchEngaged && now >= nextTick) {
      const snapshot = options.snapshot();
      const feedTime = options.lastFeedEventTime?.();
      lastFeedAge = feedTime === undefined ? undefined : now - feedTime;
      let intents: OrderIntent[] = [];
      try {
        intents = options.policy(snapshot);
      } catch {
        restWsErrorCount += 1;
      }
      try {
        const result = await options.execution.execute(intents, {
          symbol: options.symbol,
          ownership: options.ownership,
          openOrders: snapshot.openOrders,
        });
        recordExecution(rate, result.placed.length, result.canceled.length, now);
        tracked = applyExecutionToTracked(tracked, result.placed, result.canceled);
      } catch (error) {
        restWsErrorCount += 1;
        if (error instanceof RateLimitError) {
          rate.record429(now);
        }
      }
      await auditNow(options.snapshot());
      nextTick = now + options.tickMs;
    }

    if (!killSwitchCancelOnly && elapsed >= options.killSwitchCancelOnlyAtMs) {
      const drilled = await drillKillSwitch({
        mode: "CANCEL_ONLY",
        snapshot: options.snapshot(),
        options,
        rate,
        tracked,
        now,
      });
      tracked = drilled.tracked;
      flattenReduceOnly = flattenReduceOnly && drilled.flattenReduceOnly;
      killSwitchCancelOnly = true;
      killSwitchEngaged = true;
      killSwitchCount += 1;
      await auditNow(options.snapshot());
    }
    if (!killSwitchFlatten && elapsed >= options.killSwitchFlattenAtMs) {
      const drilled = await drillKillSwitch({
        mode: "CANCEL_AND_FLATTEN",
        snapshot: options.snapshot(),
        options,
        rate,
        tracked,
        now,
      });
      tracked = drilled.tracked;
      flattenReduceOnly = flattenReduceOnly && drilled.flattenReduceOnly;
      killSwitchFlatten = true;
      killSwitchEngaged = true;
      killSwitchCount += 1;
      if (!drilled.flatConfirmed) {
        const snapshot = options.snapshot();
        mismatches = [
          {
            symbol: options.symbol,
            snapshotQuantity: snapshot.position?.quantity ?? 0,
            exchangeQuantity:
              (
                await options.venue.fetchAccount(options.symbol)
              ).positions.find((row) => row.symbol === options.symbol)?.quantity ??
              0,
          },
        ];
      }
      await auditNow(options.snapshot());
    }

    if (options.clock.now() >= end) {
      break;
    }
    const step = Math.min(options.tickMs, end - options.clock.now());
    if (options.clock.advanceTo !== undefined) {
      options.clock.advanceTo(options.clock.now() + step);
    } else {
      await new Promise<void>((resolve) => {
        options.clock.setTimeout(resolve, step);
      });
    }
  }

  for (const stoppable of options.stoppables ?? []) {
    await stoppable.stop();
  }
  const leaks = leakSnapshot(options.clock);
  const finalSnapshot = options.snapshot();
  await auditNow(finalSnapshot);
  const openOrders = await options.venue.fetchOpenOrders(options.symbol);
  const elapsedMs = options.clock.now() - started;
  const position: FuturesPosition | null = finalSnapshot.position;
  const buckets = rate.buckets(options.clock.now(), started);
  const cancelAllOrdersCalls = options.cancelAllOrdersCalls?.() ?? 0;
  const mark = finalSnapshot.markPrice ?? position?.markPrice;

  const metrics: SoakMetrics = {
    wsConnectionState: wsState,
    lastFeedUpdateAgeMs: lastFeedAge,
    restLatencyMs,
    restWsErrorCount,
    orderCreateCount: buckets.reduce((sum, row) => sum + row.places, 0),
    orderCancelCount: buckets.reduce((sum, row) => sum + row.cancels, 0),
    rateLimit429Count: rate.rateLimitCount,
    openOrderCount: liveOwned(openOrders, options.ownership).length,
    positionQuantity: position?.quantity ?? 0,
    positionNotional:
      position === null || mark === undefined
        ? undefined
        : Math.abs(position.quantity) * mark,
    realizedPnl: undefined,
    unrealizedPnl: position?.unrealizedPnl,
    strategyState: options.strategyState?.() ?? finalSnapshot.lifecycle,
    protectiveCoverage: liveOwned(openOrders, options.ownership).some(
      (order) => order.reduceOnly,
    ),
    reconciliationMismatch: orphans.length + mismatches.length,
    killSwitchCount,
  };

  const checklist = evaluateSoakChecklist({
    strategyId: options.strategyId,
    windowMs: options.windowMs,
    elapsedMs,
    minWindowMs,
    wsDisconnects,
    orphanOrders: orphans,
    positionMismatches: mismatches,
    timersOutstanding: leaks.timersOutstanding,
    orderRatePerMinute: buckets,
    orderStorm: rate.hasStormAfter429(options.clock.now(), started),
    unboundedOrderRate: rate.isUnbounded(options.clock.now(), started),
    killSwitchCancelOnly,
    killSwitchFlatten,
    cancelAllOrdersCalls,
  });

  return {
    strategyId: options.strategyId,
    instanceId: options.instanceId,
    symbol: options.symbol,
    elapsedMs,
    windowMs: options.windowMs,
    wsDisconnects,
    orphanOrders: orphans,
    positionMismatches: mismatches,
    timersOutstanding: leaks.timersOutstanding,
    heapUsedBytes: leaks.heapUsedBytes,
    killSwitchCancelOnly,
    killSwitchFlatten,
    flattenReduceOnly,
    cancelAllOrdersCalls,
    metrics,
    checklist,
    productionReady: false,
  };
}

export function adapterStreamChaos(adapter: {
  injectStreamDisconnect: (target: "public" | "user" | "both") => void;
}): SoakStreamChaos {
  return {
    injectPublicDisconnect: () => {
      adapter.injectStreamDisconnect("public");
    },
    injectUserDisconnect: () => {
      adapter.injectStreamDisconnect("user");
    },
  };
}
