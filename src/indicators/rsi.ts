import { RSI } from "trading-signals";

function requireFiniteCloses(closes: readonly number[]): void {
  if (closes.some((value) => !Number.isFinite(value))) {
    throw new RangeError("closes must be finite numbers");
  }
}

export function createRsi(period: number): RSI {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError("period must be an integer greater than 0");
  }
  return new RSI(period);
}

/**
 * RSI over closed-candle closes via `trading-signals` (Wilder / WSMA).
 * Returns null until the indicator is stable. Does not invent a second formula.
 */
export function rsiFromClosedCloses(
  closes: readonly number[],
  period: number,
): number | null {
  requireFiniteCloses(closes);
  const rsi = createRsi(period);
  rsi.updates([...closes]);
  return rsi.getResult();
}
