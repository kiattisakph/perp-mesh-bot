import type { DesiredQuote } from "../../application/order-planner";
import type { OrderBook } from "../../domain/market";
import type { OrderSide } from "../../domain/order";
import {
  absQuantity,
  closeSide,
  isFlat,
  isLong,
  isShort,
} from "../../domain/position";
import {
  isSendableQuantity,
  meetsMinNotional,
  roundCloseQuantity,
  roundEntryQuantity,
  roundMakerPrice,
} from "../../domain/rounding";
import type { StrategySnapshot, SymbolPrecision } from "../../domain/strategy";
import type { MakerConfig } from "./config";

export function bestBid(book: OrderBook): number | undefined {
  const price = book.bids[0]?.price;
  return price !== undefined && Number.isFinite(price) && price > 0
    ? price
    : undefined;
}

export function bestAsk(book: OrderBook): number | undefined {
  const price = book.asks[0]?.price;
  return price !== undefined && Number.isFinite(price) && price > 0
    ? price
    : undefined;
}

export function depthQuantitySum(
  levels: readonly { quantity: number }[],
  count: number,
): number {
  const n = Math.max(0, Math.min(count, levels.length));
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const quantity = levels[i]?.quantity ?? 0;
    if (Number.isFinite(quantity) && quantity > 0) {
      sum += quantity;
    }
  }
  return sum;
}

export function bookDepths(
  book: OrderBook,
  depthLevels: number,
): { bidDepth: number; askDepth: number } {
  return {
    bidDepth: depthQuantitySum(book.bids, depthLevels),
    askDepth: depthQuantitySum(book.asks, depthLevels),
  };
}

export function skipEntrySides(
  bidDepth: number,
  askDepth: number,
  skipRatio: number,
): { skipBuy: boolean; skipSell: boolean } {
  return {
    skipSell: askDepth * skipRatio < bidDepth,
    skipBuy: bidDepth * skipRatio < askDepth,
  };
}

export function shouldForcedFlatten(input: {
  quantity: number;
  bidDepth: number;
  askDepth: number;
  forcedExitRatio: number;
}): boolean {
  if (isFlat(input.quantity)) {
    return false;
  }
  if (isLong(input.quantity)) {
    return input.bidDepth * input.forcedExitRatio < input.askDepth;
  }
  return input.askDepth * input.forcedExitRatio < input.bidDepth;
}

export function bookExitPnlUsdt(
  entryPrice: number,
  quantity: number,
  book: OrderBook,
): number | undefined {
  if (isFlat(quantity)) {
    return 0;
  }
  const exitPrice = isLong(quantity) ? bestBid(book) : bestAsk(book);
  if (exitPrice === undefined) {
    return undefined;
  }
  return (exitPrice - entryPrice) * quantity;
}

export function clampMakerPrice(
  price: number,
  side: OrderSide,
  book: OrderBook,
  tickSize: number,
): number | undefined {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  if (bid === undefined || ask === undefined) {
    return undefined;
  }
  if (side === "BUY") {
    const max = ask - tickSize;
    if (!(max > 0)) {
      return undefined;
    }
    return Math.min(price, max);
  }
  const min = bid + tickSize;
  if (!(min > 0)) {
    return undefined;
  }
  return Math.max(price, min);
}

function finalizeQuotePrice(input: {
  raw: number;
  side: OrderSide;
  book: OrderBook;
  precision: SymbolPrecision;
  clamp: boolean;
}): number | undefined {
  if (!Number.isFinite(input.raw) || input.raw <= 0) {
    return undefined;
  }
  const clamped = input.clamp
    ? clampMakerPrice(
        input.raw,
        input.side,
        input.book,
        input.precision.tickSize,
      )
    : input.raw;
  if (clamped === undefined) {
    return undefined;
  }
  const rounded = roundMakerPrice(clamped, input.side, input.precision);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    return undefined;
  }
  if (input.clamp) {
    const stillValid = clampMakerPrice(
      rounded,
      input.side,
      input.book,
      input.precision.tickSize,
    );
    if (stillValid === undefined) {
      return undefined;
    }
    if (input.side === "BUY" && rounded > stillValid) {
      return undefined;
    }
    if (input.side === "SELL" && rounded < stillValid) {
      return undefined;
    }
  }
  return rounded;
}

function levelPrice(
  book: OrderBook,
  side: OrderSide,
  level: number,
): number | undefined {
  const index = level - 1;
  if (index < 0) {
    return undefined;
  }
  const price =
    side === "BUY" ? book.bids[index]?.price : book.asks[index]?.price;
  return price !== undefined && Number.isFinite(price) && price > 0
    ? price
    : undefined;
}

export function entryQuotePrice(input: {
  book: OrderBook;
  side: OrderSide;
  level: number;
  bidOffset: number;
  askOffset: number;
  precision: SymbolPrecision;
  clamp: boolean;
}): number | undefined {
  const base = levelPrice(input.book, input.side, input.level);
  if (base === undefined) {
    return undefined;
  }
  const raw =
    input.side === "BUY" ? base - input.bidOffset : base + input.askOffset;
  return finalizeQuotePrice({
    raw,
    side: input.side,
    book: input.book,
    precision: input.precision,
    clamp: input.clamp,
  });
}

export function l1ExitPrice(input: {
  book: OrderBook;
  quantity: number;
  precision: SymbolPrecision;
  clamp: boolean;
}): number | undefined {
  if (isFlat(input.quantity)) {
    return undefined;
  }
  const side = closeSide(input.quantity);
  const raw = side === "SELL" ? bestBid(input.book) : bestAsk(input.book);
  if (raw === undefined) {
    return undefined;
  }
  return finalizeQuotePrice({
    raw,
    side,
    book: input.book,
    precision: input.precision,
    clamp: input.clamp,
  });
}

export function liquidityExitPrice(input: {
  book: OrderBook;
  quantity: number;
  entryPrice: number;
  fillOrEntry: number;
  closeTickOffset: number;
  precision: SymbolPrecision;
}): number | undefined {
  if (isFlat(input.quantity)) {
    return undefined;
  }
  const tick = input.precision.tickSize;
  const entry = input.entryPrice;
  const fillOrEntry = input.fillOrEntry;
  const side = closeSide(input.quantity);
  const raw = isLong(input.quantity)
    ? Math.max(fillOrEntry + input.closeTickOffset * tick, entry + tick)
    : Math.min(fillOrEntry - input.closeTickOffset * tick, entry - tick);
  return finalizeQuotePrice({
    raw,
    side,
    book: input.book,
    precision: input.precision,
    clamp: true,
  });
}

function quoteIfSendable(
  quote: DesiredQuote,
  precision: SymbolPrecision,
): DesiredQuote | undefined {
  if (!isSendableQuantity(quote.quantity)) {
    return undefined;
  }
  if (!meetsMinNotional(quote.quantity, quote.price, precision)) {
    return undefined;
  }
  return quote;
}

export function buildEntryQuotes(input: {
  snapshot: StrategySnapshot;
  config: MakerConfig;
  book: OrderBook;
  clamp: boolean;
  skipBuy: boolean;
  skipSell: boolean;
}): DesiredQuote[] {
  const quantity = roundEntryQuantity(
    input.config.tradeQuantity,
    input.snapshot.precision,
  );
  const quotes: DesiredQuote[] = [];
  if (!input.skipBuy) {
    const price = entryQuotePrice({
      book: input.book,
      side: "BUY",
      level: input.config.entryDepthLevel,
      bidOffset: input.config.bidOffset,
      askOffset: input.config.askOffset,
      precision: input.snapshot.precision,
      clamp: input.clamp,
    });
    if (price !== undefined) {
      const quote = quoteIfSendable(
        {
          purpose: "ENTRY_BID",
          side: "BUY",
          price,
          quantity,
          reduceOnly: false,
          postOnly: true,
        },
        input.snapshot.precision,
      );
      if (quote !== undefined) {
        quotes.push(quote);
      }
    }
  }
  if (!input.skipSell) {
    const price = entryQuotePrice({
      book: input.book,
      side: "SELL",
      level: input.config.entryDepthLevel,
      bidOffset: input.config.bidOffset,
      askOffset: input.config.askOffset,
      precision: input.snapshot.precision,
      clamp: input.clamp,
    });
    if (price !== undefined) {
      const quote = quoteIfSendable(
        {
          purpose: "ENTRY_ASK",
          side: "SELL",
          price,
          quantity,
          reduceOnly: false,
          postOnly: true,
        },
        input.snapshot.precision,
      );
      if (quote !== undefined) {
        quotes.push(quote);
      }
    }
  }
  return quotes;
}

export function buildExitQuote(input: {
  snapshot: StrategySnapshot;
  price: number;
  postOnly: boolean;
}): DesiredQuote | undefined {
  const position = input.snapshot.position;
  if (position === null || isFlat(position.quantity)) {
    return undefined;
  }
  const quantity = roundCloseQuantity(
    absQuantity(position.quantity),
    absQuantity(position.quantity),
    input.snapshot.precision,
  );
  return quoteIfSendable(
    {
      purpose: "EXIT",
      side: closeSide(position.quantity),
      price: input.price,
      quantity,
      reduceOnly: true,
      postOnly: input.postOnly,
    },
    input.snapshot.precision,
  );
}

export function fallbackFillPrice(
  book: OrderBook,
  quantity: number,
): number | undefined {
  if (isLong(quantity)) {
    return bestAsk(book);
  }
  if (isShort(quantity)) {
    return bestBid(book);
  }
  return undefined;
}
