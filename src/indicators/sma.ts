function requireFiniteCloses(closes: readonly number[]): void {
  if (closes.some((value) => !Number.isFinite(value))) {
    throw new RangeError("closes must be finite numbers");
  }
}

export function sma(closes: readonly number[], period: number): number {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError("period must be an integer greater than 0");
  }
  requireFiniteCloses(closes);
  if (closes.length < period) {
    throw new RangeError(`need at least ${period} closes for SMA`);
  }
  const window = closes.slice(-period);
  let sum = 0;
  for (const close of window) {
    sum += close;
  }
  return sum / period;
}
