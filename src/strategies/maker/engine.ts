import type { DesiredQuote } from "../../application/order-planner";
import { planQuoteIntents } from "../../application/order-planner";
import {
  isBotOwned,
  ownedEntryClientOrderIds,
  parseOwnedClientOrderId,
  type OrderOwnership,
} from "../../application/ownership";
import type { OrderIntent } from "../../domain/intent";
import type { OrderBook } from "../../domain/market";
import type { TradingOrder } from "../../domain/order";
import { absQuantity, closeSide, isFlat } from "../../domain/position";
import {
  isSendableQuantity,
  roundCloseQuantity,
} from "../../domain/rounding";
import type { StrategySnapshot } from "../../domain/strategy";
import { isFeedStale } from "../../risk/freshness";
import { isMarkSlippageAllowed } from "../../risk/slippage";
import { classicDesiredQuotes } from "./classic-policy";
import type { MakerConfig } from "./config";
import { FillTracker, type MakerFillEvent, type RecentFill } from "./fill-tracker";
import { liquidityDesiredQuotes } from "./liquidity-policy";
import { offsetDesiredQuotes } from "./offset-policy";
import { bestAsk, bestBid, bookExitPnlUsdt } from "./quotes";
import type { MakerQuotingState, MakerState } from "./state";

/**
 * Numeric cancel/replace budget (orders per minute) is TBD in maker-family.md.
 * Callers inject a limit so tests can drive the budget without inventing an env var.
 */
export class CancelReplaceBudget {
  private events: number[] = [];

  constructor(
    private readonly maxPerMinute: number,
    private readonly windowMs = 60_000,
  ) {
    if (!Number.isFinite(maxPerMinute) || maxPerMinute < 0) {
      throw new RangeError("maxPerMinute must be finite and >= 0");
    }
  }

  wouldExceed(now: number, additional: number): boolean {
    this.prune(now);
    return this.events.length + additional > this.maxPerMinute;
  }

  record(now: number, count: number): void {
    this.prune(now);
    for (let i = 0; i < count; i++) {
      this.events.push(now);
    }
  }

  get used(): number {
    return this.events.length;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    this.events = this.events.filter((at) => at >= cutoff);
  }
}

export type MakerResult = {
  intents: OrderIntent[];
  state: MakerState;
  desired: DesiredQuote[];
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

function hasPartialEntryFill(
  snapshot: StrategySnapshot,
  ownership: OrderOwnership,
): boolean {
  return snapshot.openOrders.some((order) => {
    if (order.symbol !== snapshot.symbol || order.reduceOnly) {
      return false;
    }
    if (order.status !== "PARTIALLY_FILLED") {
      return false;
    }
    return isBotOwned(order.clientOrderId, ownership);
  });
}

function inPosition(snapshot: StrategySnapshot): boolean {
  return snapshot.position !== null && !isFlat(snapshot.position.quantity);
}

function depthStale(snapshot: StrategySnapshot, config: MakerConfig): boolean {
  const book = snapshot.orderBook;
  if (book === undefined) {
    return true;
  }
  return isFeedStale({
    eventTime: book.eventTime,
    now: snapshot.now,
    staleMs: config.feedStaleMs,
  });
}

function quotingPhase(
  snapshot: StrategySnapshot,
  exitOnly: boolean,
): MakerQuotingState {
  if (snapshot.lifecycle === "STARTING") {
    return "STARTING";
  }
  if (snapshot.lifecycle === "RECONCILING") {
    return "RECONCILING";
  }
  if (snapshot.rateLimitState === "PAUSED") {
    return "PAUSED";
  }
  if (snapshot.rateLimitState === "DEGRADED") {
    return "DEGRADED";
  }
  if (exitOnly) {
    return "POSITION_EXIT_ONLY";
  }
  return "FLAT_QUOTING";
}

function entryLifecycleOk(lifecycle: StrategySnapshot["lifecycle"]): boolean {
  return lifecycle === "READY" || lifecycle === "RUNNING";
}

function cancelLeftoverEntries(
  snapshot: StrategySnapshot,
  ownership: OrderOwnership,
): OrderIntent[] {
  const leftover = ownedEntryClientOrderIds(snapshot.openOrders, ownership);
  if (leftover.length === 0) {
    return [];
  }
  return [
    {
      type: "CANCEL",
      strategyId: snapshot.strategyId,
      orderIds: leftover,
    },
  ];
}

function cancelOwnedLimits(
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

function reduceOnlyMarketClose(
  snapshot: StrategySnapshot,
  config: MakerConfig,
  book: OrderBook | undefined,
  reason: string,
): OrderIntent | undefined {
  const position = snapshot.position;
  if (position === null || isFlat(position.quantity)) {
    return undefined;
  }
  const mark =
    snapshot.markPrice ??
    snapshot.ticker?.markPrice ??
    (Number.isFinite(position.markPrice) ? position.markPrice : undefined);
  if (mark === undefined || mark <= 0) {
    return undefined;
  }
  const bookPrice =
    book === undefined
      ? undefined
      : position.quantity > 0
        ? bestBid(book)
        : bestAsk(book);
  const candidate = bookPrice ?? mark;
  if (
    !isMarkSlippageAllowed(candidate, mark, config.maxCloseSlippageFraction)
  ) {
    return undefined;
  }
  const quantity = roundCloseQuantity(
    absQuantity(position.quantity),
    absQuantity(position.quantity),
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
    reason,
  };
}

function tickDelta(left: number, right: number, tickSize: number): number {
  return Math.abs(left - right) / tickSize;
}

function stabilizeForDwell(input: {
  desired: readonly DesiredQuote[];
  openOrders: readonly TradingOrder[];
  ownership: OrderOwnership;
  now: number;
  repriceTicks: number;
  minDwellMs: number;
  tickSize: number;
}): DesiredQuote[] {
  const purposeOf = (
    quote: DesiredQuote,
  ): "bid" | "ask" | "exit" => {
    if (quote.purpose === "ENTRY_BID") {
      return "bid";
    }
    if (quote.purpose === "ENTRY_ASK") {
      return "ask";
    }
    return "exit";
  };
  return input.desired.map((quote) => {
    const purpose = purposeOf(quote);
    const existing = input.openOrders.find((order) => {
      if (!isLive(order) || !isBotOwned(order.clientOrderId, input.ownership)) {
        return false;
      }
      const parsed = parseOwnedClientOrderId(order.clientOrderId, input.ownership);
      return parsed?.purpose === purpose;
    });
    if (existing === undefined || existing.price === undefined) {
      return quote;
    }
    if (existing.quantity !== quote.quantity) {
      return quote;
    }
    const ticks = tickDelta(quote.price, existing.price, input.tickSize);
    const age = input.now - existing.updateTime;
    if (ticks < input.repriceTicks || age < input.minDwellMs) {
      return { ...quote, price: existing.price };
    }
    return quote;
  });
}

function quoteOpCount(intents: readonly OrderIntent[]): number {
  let count = 0;
  for (const intent of intents) {
    if (intent.type === "CANCEL") {
      count += intent.orderIds.length;
    } else if (intent.type === "PLACE_LIMIT") {
      count += 1;
    }
  }
  return count;
}

function policyQuotes(input: {
  snapshot: StrategySnapshot;
  config: MakerConfig;
  book: OrderBook;
  recentFill: RecentFill | undefined;
}): { desired: DesiredQuote[]; flatten: boolean } {
  if (input.config.variant === "offset") {
    return offsetDesiredQuotes({
      snapshot: input.snapshot,
      config: input.config,
      book: input.book,
    });
  }
  if (input.config.variant === "liquidity") {
    return {
      desired: liquidityDesiredQuotes({
        snapshot: input.snapshot,
        config: input.config,
        book: input.book,
        recentFill: input.recentFill,
        now: input.snapshot.now,
      }),
      flatten: false,
    };
  }
  return {
    desired: classicDesiredQuotes({
      snapshot: input.snapshot,
      config: input.config,
      book: input.book,
    }),
    flatten: false,
  };
}

export function evaluateMaker(input: {
  snapshot: StrategySnapshot;
  config: MakerConfig;
  ownership: OrderOwnership;
  recentFill?: RecentFill;
  budget?: CancelReplaceBudget;
}): MakerResult {
  const { snapshot, config, ownership } = input;
  const book = snapshot.orderBook;
  const stale = depthStale(snapshot, config);
  const exitOnly =
    inPosition(snapshot) || hasPartialEntryFill(snapshot, ownership);
  const phase = quotingPhase(snapshot, exitOnly);
  const state: MakerState = { phase };
  const owned = ownedLive(snapshot, ownership);

  const protection: OrderIntent[] = [];
  const position = snapshot.position;
  if (
    position !== null &&
    !isFlat(position.quantity) &&
    book !== undefined &&
    !stale
  ) {
    const pnl = bookExitPnlUsdt(
      position.entryPrice,
      position.quantity,
      book,
    );
    if (pnl !== undefined && pnl < -config.lossLimitUsdt) {
      protection.push(...cancelOwnedLimits(snapshot.strategyId, owned));
      const close = reduceOnlyMarketClose(
        snapshot,
        config,
        book,
        "maker_loss_limit",
      );
      if (close !== undefined) {
        protection.push(close);
      }
      return { intents: protection, state, desired: [] };
    }
  }

  if (stale || book === undefined) {
    if (exitOnly) {
      protection.push(...cancelLeftoverEntries(snapshot, ownership));
    }
    return { intents: protection, state, desired: [] };
  }

  const { desired: rawDesired, flatten } = policyQuotes({
    snapshot,
    config,
    book,
    recentFill: input.recentFill,
  });

  if (flatten) {
    protection.push(...cancelOwnedLimits(snapshot.strategyId, owned));
    const close = reduceOnlyMarketClose(
      snapshot,
      config,
      book,
      "offset_imbalance_flatten",
    );
    if (close !== undefined) {
      protection.push(close);
    }
    return { intents: protection, state, desired: [] };
  }

  const stopQuoteUpdates =
    stale ||
    snapshot.rateLimitState !== "NORMAL" ||
    snapshot.lifecycle === "STARTING" ||
    snapshot.lifecycle === "RECONCILING";
  const stopEntry =
    stopQuoteUpdates ||
    exitOnly ||
    snapshot.rateLimitState !== "NORMAL" ||
    !entryLifecycleOk(snapshot.lifecycle);

  let desired = rawDesired;
  if (stopEntry) {
    desired = desired.filter((quote) => quote.purpose === "EXIT");
  }

  if (stopQuoteUpdates) {
    if (exitOnly) {
      protection.push(...cancelLeftoverEntries(snapshot, ownership));
    }
    const hasLiveExit = owned.some((order) => {
      const parsed = parseOwnedClientOrderId(order.clientOrderId, ownership);
      return parsed?.purpose === "exit" && order.reduceOnly;
    });
    const missingExit = desired.some((quote) => quote.purpose === "EXIT");
    if (exitOnly && missingExit && !hasLiveExit) {
      const exitOnlyDesired = desired.filter((quote) => quote.purpose === "EXIT");
      const planned = planQuoteIntents({
        desired: exitOnlyDesired,
        openOrders: snapshot.openOrders,
        ownership,
        strategyId: snapshot.strategyId,
        symbol: snapshot.symbol,
      });
      const exitPlaces = planned.filter(
        (intent) => intent.type === "PLACE_LIMIT" && intent.reduceOnly,
      );
      return {
        intents: [...protection, ...exitPlaces],
        state,
        desired: exitOnlyDesired,
      };
    }
    return { intents: protection, state, desired: [] };
  }

  desired = stabilizeForDwell({
    desired,
    openOrders: snapshot.openOrders,
    ownership,
    now: snapshot.now,
    repriceTicks: config.repriceTicks,
    minDwellMs: config.minDwellMs,
    tickSize: snapshot.precision.tickSize,
  });

  const planned = planQuoteIntents({
    desired,
    openOrders: snapshot.openOrders,
    ownership,
    strategyId: snapshot.strategyId,
    symbol: snapshot.symbol,
  });
  const ops = quoteOpCount(planned);
  if (input.budget !== undefined && input.budget.wouldExceed(snapshot.now, ops)) {
    const hasLiveExit = owned.some((order) => {
      const parsed = parseOwnedClientOrderId(order.clientOrderId, ownership);
      return parsed?.purpose === "exit" && order.reduceOnly;
    });
    const exitPlaces =
      exitOnly && !hasLiveExit
        ? planned.filter(
            (intent) => intent.type === "PLACE_LIMIT" && intent.reduceOnly,
          )
        : [];
    return { intents: [...protection, ...exitPlaces], state, desired };
  }
  if (input.budget !== undefined && ops > 0) {
    input.budget.record(snapshot.now, ops);
  }
  return { intents: [...protection, ...planned], state, desired };
}

export class MakerRuntime {
  readonly fills = new FillTracker();
  readonly budget: CancelReplaceBudget | undefined;

  constructor(
    private readonly config: MakerConfig,
    budgetMaxPerMinute?: number,
  ) {
    this.budget =
      budgetMaxPerMinute === undefined
        ? undefined
        : new CancelReplaceBudget(budgetMaxPerMinute);
  }

  onExecutionReport(event: MakerFillEvent): void {
    this.fills.apply(event);
  }

  evaluate(input: {
    snapshot: StrategySnapshot;
    ownership: OrderOwnership;
  }): MakerResult {
    const position = input.snapshot.position;
    if (position !== null) {
      this.fills.reconcileFromPosition({
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        now: input.snapshot.now,
      });
    } else {
      this.fills.reconcileFromPosition({
        quantity: 0,
        entryPrice: 0,
        now: input.snapshot.now,
      });
    }
    return evaluateMaker({
      snapshot: input.snapshot,
      config: this.config,
      ownership: input.ownership,
      recentFill: this.fills.snapshot(),
      budget: this.budget,
    });
  }
}
