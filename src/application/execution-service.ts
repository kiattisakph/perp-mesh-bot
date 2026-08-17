import type { OrderIntent, PlaceIntent } from "../domain/intent";
import { isPlaceIntent } from "../domain/intent";
import type { TradingOrder } from "../domain/order";
import {
  RateLimitError,
  UnknownExecutionError,
} from "../infrastructure/binance-usdm/errors";
import type { ExecutionVenue } from "./execution-venue";
import {
  buildClientOrderId,
  isBotOwned,
  nextClientOrderSequence,
  purposeOf,
  type OrderOwnership,
} from "./ownership";

export type ExecutionLog = (
  event: string,
  details?: Record<string, unknown>,
) => void;

export type ExecutionContext = {
  symbol: string;
  ownership: OrderOwnership;
  openOrders: TradingOrder[];
};

export type ExecutionResult = {
  placed: TradingOrder[];
  canceled: TradingOrder[];
  unknownCancelsQueried: number;
  skipped: OrderIntent[];
};

function liveStatuses(status: TradingOrder["status"]): boolean {
  return status === "NEW" || status === "PARTIALLY_FILLED";
}

export class ExecutionService {
  private sequence: number;
  private busy = false;
  private readonly inFlight = new Map<string, TradingOrder>();

  constructor(
    private readonly venue: ExecutionVenue,
    private readonly ownership: OrderOwnership,
    private readonly log?: ExecutionLog,
    startSequence = 1,
  ) {
    this.sequence = startSequence;
  }

  static fromOpenOrders(
    venue: ExecutionVenue,
    ownership: OrderOwnership,
    openOrders: readonly TradingOrder[],
    log?: ExecutionLog,
  ): ExecutionService {
    const sequence = nextClientOrderSequence(
      openOrders.map((order) => order.clientOrderId),
      ownership,
    );
    return new ExecutionService(venue, ownership, log, sequence);
  }

  inFlightOrders(): TradingOrder[] {
    return [...this.inFlight.values()];
  }

  async execute(
    intents: readonly OrderIntent[],
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    if (this.busy) {
      throw new Error("overlapping execution is not allowed");
    }
    this.busy = true;
    const result: ExecutionResult = {
      placed: [],
      canceled: [],
      unknownCancelsQueried: 0,
      skipped: [],
    };
    try {
      const cancels = intents.filter(
        (intent) => intent.type === "CANCEL" || intent.type === "CANCEL_OWNED",
      );
      const places = intents.filter(isPlaceIntent);
      for (const intent of cancels) {
        await this.runCancel(intent, context, result);
      }
      for (const intent of places) {
        await this.runPlace(intent, context, result);
      }
      return result;
    } finally {
      this.busy = false;
    }
  }

  private async runPlace(
    intent: PlaceIntent,
    context: ExecutionContext,
    result: ExecutionResult,
  ): Promise<void> {
    const clientOrderId = buildClientOrderId({
      ownership: this.ownership,
      purpose: purposeOf(intent),
      sequence: this.sequence,
    });
    this.sequence += 1;
    const inflight: TradingOrder = {
      exchangeOrderId: "",
      clientOrderId,
      strategyId: intent.strategyId,
      symbol: intent.symbol,
      side: intent.side,
      type:
        intent.type === "PLACE_LIMIT"
          ? "LIMIT"
          : intent.type === "PLACE_MARKET"
            ? "MARKET"
            : intent.type === "PLACE_STOP"
              ? "STOP_MARKET"
              : "TRAILING_STOP_MARKET",
      status: "NEW",
      quantity: intent.quantity,
      filledQuantity: 0,
      reduceOnly: intent.reduceOnly,
      updateTime: 0,
    };
    this.inFlight.set(clientOrderId, inflight);
    try {
      const placed = await this.venue.placeFromIntent(intent, clientOrderId);
      this.inFlight.delete(clientOrderId);
      result.placed.push(placed);
      this.log?.("order_placed", {
        clientOrderId: placed.clientOrderId,
        symbol: placed.symbol,
        side: placed.side,
        reduceOnly: placed.reduceOnly,
        type: placed.type,
      });
    } catch (error) {
      if (error instanceof UnknownExecutionError) {
        const queried = await this.queryAfterUnknownPlace(
          intent.symbol,
          clientOrderId,
        );
        this.inFlight.delete(clientOrderId);
        if (queried !== undefined) {
          result.placed.push(queried);
          return;
        }
        this.log?.("order_place_unknown", {
          clientOrderId,
          symbol: intent.symbol,
        });
        result.skipped.push(intent);
        return;
      }
      this.inFlight.delete(clientOrderId);
      if (error instanceof RateLimitError) {
        throw error;
      }
      throw error;
    }
  }

  private async queryAfterUnknownPlace(
    symbol: string,
    clientOrderId: string,
  ): Promise<TradingOrder | undefined> {
    try {
      return await this.venue.queryOrder({
        symbol,
        origClientOrderId: clientOrderId,
      });
    } catch {
      try {
        const open = await this.venue.fetchOpenOrders(symbol);
        return open.find((order) => order.clientOrderId === clientOrderId);
      } catch {
        return undefined;
      }
    }
  }

  private async runCancel(
    intent: Extract<OrderIntent, { type: "CANCEL" } | { type: "CANCEL_OWNED" }>,
    context: ExecutionContext,
    result: ExecutionResult,
  ): Promise<void> {
    const targets = await this.cancelTargets(intent, context);
    for (const order of targets) {
      if (!isBotOwned(order.clientOrderId, this.ownership)) {
        this.log?.("cancel_skipped_unowned", {
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
        });
        continue;
      }
      const canceled = await this.cancelOwned(context.symbol, order, result);
      if (canceled !== undefined) {
        result.canceled.push(canceled);
      }
    }
  }

  private async cancelTargets(
    intent: Extract<OrderIntent, { type: "CANCEL" } | { type: "CANCEL_OWNED" }>,
    context: ExecutionContext,
  ): Promise<TradingOrder[]> {
    const open = await this.mergeOpen(context);
    if (intent.type === "CANCEL_OWNED") {
      return open.filter(
        (order) =>
          order.symbol === intent.symbol &&
          isBotOwned(order.clientOrderId, this.ownership) &&
          liveStatuses(order.status),
      );
    }
    const found: TradingOrder[] = [];
    for (const id of intent.orderIds) {
      const order = open.find(
        (row) => row.exchangeOrderId === id || row.clientOrderId === id,
      );
      if (order === undefined) {
        continue;
      }
      if (!isBotOwned(order.clientOrderId, this.ownership)) {
        this.log?.("cancel_skipped_unowned", {
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
        });
        continue;
      }
      found.push(order);
    }
    return found;
  }

  private async mergeOpen(context: ExecutionContext): Promise<TradingOrder[]> {
    const byId = new Map<string, TradingOrder>();
    for (const order of context.openOrders) {
      byId.set(order.clientOrderId, order);
    }
    for (const order of this.inFlight.values()) {
      byId.set(order.clientOrderId, order);
    }
    return [...byId.values()];
  }

  private async cancelOwned(
    symbol: string,
    order: TradingOrder,
    result: ExecutionResult,
  ): Promise<TradingOrder | undefined> {
    try {
      const canceled = await this.venue.cancelOrder({
        symbol,
        origClientOrderId: order.clientOrderId,
      });
      this.inFlight.delete(order.clientOrderId);
      this.log?.("order_canceled", {
        clientOrderId: canceled.clientOrderId,
        symbol: canceled.symbol,
      });
      return canceled;
    } catch (error) {
      if (error instanceof RateLimitError) {
        throw error;
      }
      result.unknownCancelsQueried += 1;
      const resolved = await this.queryAfterUnknownCancel(symbol, order);
      this.log?.("cancel_unknown_queried", {
        clientOrderId: order.clientOrderId,
        symbol,
        stillOpen: resolved !== undefined && liveStatuses(resolved.status),
      });
      if (resolved !== undefined && !liveStatuses(resolved.status)) {
        this.inFlight.delete(order.clientOrderId);
        return resolved;
      }
      return undefined;
    }
  }

  private async queryAfterUnknownCancel(
    symbol: string,
    order: TradingOrder,
  ): Promise<TradingOrder | undefined> {
    try {
      return await this.venue.queryOrder({
        symbol,
        origClientOrderId: order.clientOrderId,
      });
    } catch {
      const open = await this.venue.fetchOpenOrders(symbol);
      return open.find(
        (row) =>
          row.clientOrderId === order.clientOrderId ||
          row.exchangeOrderId === order.exchangeOrderId,
      );
    }
  }
}
