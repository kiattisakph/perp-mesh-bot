import type { DesiredQuote } from "../../application/order-planner";
import type { OrderBook } from "../../domain/market";
import { isFlat } from "../../domain/position";
import type { StrategySnapshot } from "../../domain/strategy";
import type { MakerConfig } from "./config";
import {
  bookDepths,
  buildEntryQuotes,
  buildExitQuote,
  l1ExitPrice,
  shouldForcedFlatten,
  skipEntrySides,
} from "./quotes";

export type OffsetPolicyResult = {
  desired: DesiredQuote[];
  flatten: boolean;
};

export function offsetDesiredQuotes(input: {
  snapshot: StrategySnapshot;
  config: MakerConfig;
  book: OrderBook;
}): OffsetPolicyResult {
  const { bidDepth, askDepth } = bookDepths(input.book, input.config.depthLevels);
  const position = input.snapshot.position;
  const flatten =
    position !== null &&
    shouldForcedFlatten({
      quantity: position.quantity,
      bidDepth,
      askDepth,
      forcedExitRatio: input.config.forcedExitRatio,
    });
  if (flatten) {
    return { desired: [], flatten: true };
  }
  if (position !== null && !isFlat(position.quantity)) {
    const price = l1ExitPrice({
      book: input.book,
      quantity: position.quantity,
      precision: input.snapshot.precision,
      clamp: true,
    });
    if (price === undefined) {
      return { desired: [], flatten: false };
    }
    const exit = buildExitQuote({
      snapshot: input.snapshot,
      price,
      postOnly: false,
    });
    return { desired: exit === undefined ? [] : [exit], flatten: false };
  }
  const skip = skipEntrySides(bidDepth, askDepth, input.config.skipRatio);
  return {
    desired: buildEntryQuotes({
      snapshot: input.snapshot,
      config: input.config,
      book: input.book,
      clamp: true,
      skipBuy: skip.skipBuy,
      skipSell: skip.skipSell,
    }),
    flatten: false,
  };
}
