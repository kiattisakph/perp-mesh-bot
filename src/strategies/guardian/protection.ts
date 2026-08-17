import { roundToTick } from "../../domain/rounding";
import { isRiskReducingStopMove, usdStopPrice } from "../../risk/stop-loss";

/**
 * Mark-based unrealized PnL used for profit lock.
 *
 * guardian.md marks `profit` as TBD (unrealized vs mark vs last). Protection
 * uses the mark-price feed (domain invariant 6), so this is
 * `(markPrice - entryPrice) * quantity`.
 */
export function markUnrealizedPnl(
  entryPrice: number,
  markPrice: number,
  quantity: number,
): number {
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(markPrice) ||
    !Number.isFinite(quantity)
  ) {
    throw new RangeError("entryPrice, markPrice, and quantity must be finite");
  }
  return (markPrice - entryPrice) * quantity;
}

export function trailingActivationPrice(input: {
  entryPrice: number;
  quantity: number;
  trailingProfitUsd: number;
}): number {
  const { entryPrice, quantity, trailingProfitUsd } = input;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new RangeError("entryPrice must be finite and greater than 0");
  }
  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new RangeError("quantity must be a non-zero finite number");
  }
  if (!Number.isFinite(trailingProfitUsd) || trailingProfitUsd <= 0) {
    throw new RangeError("trailingProfitUsd must be finite and greater than 0");
  }
  if (quantity > 0) {
    return entryPrice + trailingProfitUsd / quantity;
  }
  return entryPrice - trailingProfitUsd / Math.abs(quantity);
}

/**
 * `steps = 1 + floor((profit - triggerUsd) / offsetUsd)` when profit has
 * reached the trigger; otherwise 0 so the USD stop is left in place.
 */
export function profitLockSteps(input: {
  profit: number;
  triggerUsd: number;
  offsetUsd: number;
}): number {
  const { profit, triggerUsd, offsetUsd } = input;
  if (!Number.isFinite(profit)) {
    throw new RangeError("profit must be finite");
  }
  if (!Number.isFinite(triggerUsd) || triggerUsd <= 0) {
    throw new RangeError("triggerUsd must be finite and greater than 0");
  }
  if (!Number.isFinite(offsetUsd) || offsetUsd <= 0) {
    throw new RangeError("offsetUsd must be finite and greater than 0");
  }
  if (profit < triggerUsd) {
    return 0;
  }
  return 1 + Math.floor((profit - triggerUsd) / offsetUsd);
}

/**
 * guardian.md TBD: `newStop = f(steps)` is not specified.
 *
 * Composed from the documented USD stop, step count, and
 * `PROFIT_LOCK_STEP_USDT` as a USDT step width, moving only
 * risk-reducing:
 *
 *   long  = usdStop + steps * offsetUsd / quantity
 *   short = usdStop - steps * offsetUsd / abs(quantity)
 */
export function profitLockStopPrice(input: {
  entryPrice: number;
  quantity: number;
  lossUsd: number;
  profit: number;
  triggerUsd: number;
  offsetUsd: number;
}): number {
  const base = usdStopPrice({
    entryPrice: input.entryPrice,
    quantity: input.quantity,
    lossUsd: input.lossUsd,
  });
  const steps = profitLockSteps({
    profit: input.profit,
    triggerUsd: input.triggerUsd,
    offsetUsd: input.offsetUsd,
  });
  if (steps < 1) {
    return base;
  }
  const shift = (steps * input.offsetUsd) / Math.abs(input.quantity);
  const next = input.quantity > 0 ? base + shift : base - shift;
  if (
    !isRiskReducingStopMove({
      quantity: input.quantity,
      previousStop: base,
      nextStop: next,
    })
  ) {
    return base;
  }
  return next;
}

export function roundProtectivePrice(
  price: number,
  quantity: number,
  tickSize: number,
): number {
  return roundToTick(price, tickSize, quantity > 0 ? "up" : "down");
}
