import type { DesiredQuote } from "../../application/order-planner";
import type { OrderBook } from "../../domain/market";
import { isFlat } from "../../domain/position";
import type { StrategySnapshot } from "../../domain/strategy";
import type { MakerConfig } from "./config";
import { buildEntryQuotes, buildExitQuote, l1ExitPrice } from "./quotes";

/**
 * Classic exit price is TBD in maker-family.md (no formula; Offset uses L1;
 * do not copy Liquidity breakeven). Offset is Classic plus imbalance and
 * uses L1, so Classic uses L1 without the Offset maker clamp.
 */
export function classicDesiredQuotes(input: {
  snapshot: StrategySnapshot;
  config: MakerConfig;
  book: OrderBook;
}): DesiredQuote[] {
  const position = input.snapshot.position;
  if (position !== null && !isFlat(position.quantity)) {
    const price = l1ExitPrice({
      book: input.book,
      quantity: position.quantity,
      precision: input.snapshot.precision,
      clamp: false,
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
  return buildEntryQuotes({
    snapshot: input.snapshot,
    config: input.config,
    book: input.book,
    clamp: false,
    skipBuy: false,
    skipSell: false,
  });
}
