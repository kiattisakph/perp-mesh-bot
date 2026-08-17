import type { DesiredQuote } from "../../application/order-planner";
import type { OrderBook } from "../../domain/market";
import { isFlat } from "../../domain/position";
import type { StrategySnapshot } from "../../domain/strategy";
import type { MakerConfig } from "./config";
import type { RecentFill } from "./fill-tracker";
import {
  bookDepths,
  buildEntryQuotes,
  buildExitQuote,
  fallbackFillPrice,
  liquidityExitPrice,
  skipEntrySides,
} from "./quotes";

/**
 * Liquidity exit GTX/post-only is TBD in maker-family.md. Spec requires maker
 * clamp on the exit; GTC reduce-only limit is allowed.
 */
export function liquidityDesiredQuotes(input: {
  snapshot: StrategySnapshot;
  config: MakerConfig;
  book: OrderBook;
  recentFill: RecentFill | undefined;
  now: number;
}): DesiredQuote[] {
  const { bidDepth, askDepth } = bookDepths(input.book, input.config.depthLevels);
  const position = input.snapshot.position;
  if (position !== null && !isFlat(position.quantity)) {
    const fillFresh =
      input.recentFill !== undefined &&
      input.now - input.recentFill.eventTime <= input.config.recentFillMs
        ? input.recentFill
        : undefined;
    const fillOrEntry =
      fillFresh !== undefined
        ? fillFresh.price
        : position.entryPrice > 0
          ? position.entryPrice
          : fallbackFillPrice(input.book, position.quantity);
    if (fillOrEntry === undefined) {
      return [];
    }
    const entryPrice =
      position.entryPrice > 0 ? position.entryPrice : fillOrEntry;
    const price = liquidityExitPrice({
      book: input.book,
      quantity: position.quantity,
      entryPrice,
      fillOrEntry,
      closeTickOffset: input.config.closeTickOffset,
      precision: input.snapshot.precision,
    });
    if (price === undefined) {
      return [];
    }
    const exit = buildExitQuote({
      snapshot: input.snapshot,
      price,
      postOnly: false,
    });
    return exit === undefined ? [] : [exit];
  }
  const skip = skipEntrySides(bidDepth, askDepth, input.config.skipRatio);
  return buildEntryQuotes({
    snapshot: input.snapshot,
    config: input.config,
    book: input.book,
    clamp: true,
    skipBuy: skip.skipBuy,
    skipSell: skip.skipSell,
  });
}
