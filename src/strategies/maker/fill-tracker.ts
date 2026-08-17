import type { OrderSide, OrderStatus } from "../../domain/order";
import { isFlat } from "../../domain/position";

export type MakerFillEvent = {
  symbol: string;
  clientOrderId: string;
  executionType: string;
  orderStatus: OrderStatus;
  side: OrderSide;
  reduceOnly: boolean;
  lastFilledQuantity: number;
  accumulatedFilledQuantity: number;
  lastFillPrice: number;
  averageFillPrice: number;
  eventTime: number;
};

export type RecentFill = {
  price: number;
  eventTime: number;
  accumulatedFilledQuantity: number;
};

function tradePrice(event: MakerFillEvent): number | undefined {
  if (event.lastFillPrice > 0 && Number.isFinite(event.lastFillPrice)) {
    return event.lastFillPrice;
  }
  if (event.averageFillPrice > 0 && Number.isFinite(event.averageFillPrice)) {
    return event.averageFillPrice;
  }
  return undefined;
}

export class FillTracker {
  private latest: RecentFill | undefined;
  private lastPositionQty = 0;

  apply(event: MakerFillEvent): void {
    if (event.executionType !== "TRADE") {
      return;
    }
    if (event.reduceOnly) {
      return;
    }
    if (!(event.lastFilledQuantity > 0)) {
      return;
    }
    const price = tradePrice(event);
    if (price === undefined) {
      return;
    }
    this.latest = {
      price,
      eventTime: event.eventTime,
      accumulatedFilledQuantity: event.accumulatedFilledQuantity,
    };
  }

  reconcileFromPosition(input: {
    quantity: number;
    entryPrice: number;
    now: number;
  }): void {
    if (isFlat(input.quantity)) {
      if (!isFlat(this.lastPositionQty)) {
        this.latest = undefined;
      }
      this.lastPositionQty = 0;
      return;
    }
    const absNow = Math.abs(input.quantity);
    const absPrev = Math.abs(this.lastPositionQty);
    this.lastPositionQty = input.quantity;
    if (this.latest !== undefined) {
      return;
    }
    if (absNow > absPrev && input.entryPrice > 0) {
      this.latest = {
        price: input.entryPrice,
        eventTime: input.now,
        accumulatedFilledQuantity: absNow,
      };
    }
  }

  recentFill(now: number, maxAgeMs: number): RecentFill | undefined {
    if (this.latest === undefined) {
      return undefined;
    }
    if (now - this.latest.eventTime > maxAgeMs) {
      return undefined;
    }
    return this.latest;
  }

  snapshot(): RecentFill | undefined {
    return this.latest;
  }

  reset(): void {
    this.latest = undefined;
    this.lastPositionQty = 0;
  }
}
