function requireFiniteCloses(closes: readonly number[]): void {
  if (closes.some((value) => !Number.isFinite(value))) {
    throw new RangeError("closes must be finite numbers");
  }
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("values must be non-empty");
  }
  requireFiniteCloses(values);
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/** Population standard deviation (divide by n, not n-1). */
export function populationStandardDeviation(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("values must be non-empty");
  }
  const avg = mean(values);
  let sumSquares = 0;
  for (const value of values) {
    const delta = value - avg;
    sumSquares += delta * delta;
  }
  return Math.sqrt(sumSquares / values.length);
}

/**
 * Bollinger bandwidth from trend.md:
 * `(2 × std × multiplier) / mean` using closed-candle closes.
 */
export function bollingerBandwidth(
  closes: readonly number[],
  length: number,
  multiplier: number,
): number {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError("length must be an integer greater than 0");
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError("multiplier must be finite and greater than 0");
  }
  requireFiniteCloses(closes);
  if (closes.length < length) {
    throw new RangeError(`need at least ${length} closes for Bollinger`);
  }
  const window = closes.slice(-length);
  const avg = mean(window);
  if (avg === 0) {
    throw new RangeError("Bollinger mean must be non-zero");
  }
  const std = populationStandardDeviation(window);
  return (2 * std * multiplier) / avg;
}
