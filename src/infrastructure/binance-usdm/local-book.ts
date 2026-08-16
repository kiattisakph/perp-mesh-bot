import type { OrderBook, PriceLevel } from "../../domain/market";
import { MapperError } from "./errors";
import { sortDepth } from "./mapper";

export type DepthDiff = {
  symbol: string;
  eventTime: number;
  firstUpdateId: number;
  finalUpdateId: number;
  previousFinalUpdateId: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MapperError("depth diff must be an object");
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new MapperError(`${label} must be a finite number`);
}

function asLevels(value: unknown, label: string): PriceLevel[] {
  if (!Array.isArray(value)) {
    throw new MapperError(`${label} must be an array`);
  }
  return value.map((level, index) => {
    if (!Array.isArray(level)) {
      throw new MapperError(`${label}[${index}] must be a pair`);
    }
    return {
      price: asNumber(level[0], `${label}[${index}].price`),
      quantity: asNumber(level[1], `${label}[${index}].quantity`),
    };
  });
}

export function parseDepthDiff(payload: unknown): DepthDiff {
  const row = asRecord(payload);
  return {
    symbol: String(row.s),
    eventTime: asNumber(row.E, "E"),
    firstUpdateId: asNumber(row.U, "U"),
    finalUpdateId: asNumber(row.u, "u"),
    previousFinalUpdateId: asNumber(row.pu, "pu"),
    bids: asLevels(row.b, "b"),
    asks: asLevels(row.a, "a"),
  };
}

function applyLevel(side: Map<number, number>, level: PriceLevel): void {
  if (level.quantity === 0) {
    side.delete(level.price);
    return;
  }
  side.set(level.price, level.quantity);
}

export type LocalBookStatus = "idle" | "buffering" | "ready" | "gap";

export class LocalOrderBook {
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private readonly buffer: DepthDiff[] = [];
  private lastUpdateId = 0;
  private synced = false;
  private eventTime = 0;
  private symbol = "";
  private status: LocalBookStatus = "idle";

  startBuffering(): void {
    this.buffer.length = 0;
    this.synced = false;
    this.status = "buffering";
  }

  applySnapshot(book: OrderBook): LocalBookStatus {
    this.bids.clear();
    this.asks.clear();
    this.symbol = book.symbol;
    this.eventTime = book.eventTime;
    this.lastUpdateId = book.sequence;
    this.synced = false;
    for (const level of book.bids) {
      applyLevel(this.bids, level);
    }
    for (const level of book.asks) {
      applyLevel(this.asks, level);
    }
    const pending = this.buffer.splice(0);
    this.status = "ready";
    for (const diff of pending) {
      if (this.applyDiff(diff) === "gap") {
        return this.status;
      }
    }
    return this.status;
  }

  applyDiff(diff: DepthDiff): LocalBookStatus {
    if (this.status === "buffering") {
      this.buffer.push(diff);
      return this.status;
    }
    if (this.status !== "ready") {
      return this.status;
    }
    if (diff.finalUpdateId < this.lastUpdateId) {
      return this.status;
    }
    if (!this.synced) {
      const bridgesSnapshot =
        diff.firstUpdateId <= this.lastUpdateId &&
        diff.finalUpdateId >= this.lastUpdateId;
      if (!bridgesSnapshot) {
        this.status = "gap";
        return this.status;
      }
      this.synced = true;
    } else if (diff.previousFinalUpdateId !== this.lastUpdateId) {
      this.status = "gap";
      return this.status;
    }

    this.symbol = diff.symbol;
    this.eventTime = diff.eventTime;
    this.lastUpdateId = diff.finalUpdateId;
    for (const level of diff.bids) {
      applyLevel(this.bids, level);
    }
    for (const level of diff.asks) {
      applyLevel(this.asks, level);
    }
    this.status = "ready";
    return this.status;
  }

  currentStatus(): LocalBookStatus {
    return this.status;
  }

  snapshot(): OrderBook | undefined {
    if (this.status !== "ready") {
      return undefined;
    }
    const toLevels = (side: Map<number, number>): PriceLevel[] =>
      [...side.entries()].map(([price, quantity]) => ({ price, quantity }));
    return sortDepth({
      symbol: this.symbol,
      bids: toLevels(this.bids),
      asks: toLevels(this.asks),
      eventTime: this.eventTime,
      sequence: this.lastUpdateId,
    });
  }
}
