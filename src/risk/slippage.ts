export function markSlippageDistance(
  candidatePrice: number,
  markPrice: number,
): number {
  if (!Number.isFinite(candidatePrice) || !Number.isFinite(markPrice)) {
    throw new RangeError("candidatePrice and markPrice must be finite");
  }
  if (markPrice <= 0) {
    throw new RangeError("markPrice must be greater than 0");
  }
  return Math.abs(candidatePrice - markPrice) / markPrice;
}

export function isMarkSlippageAllowed(
  candidatePrice: number,
  markPrice: number,
  maxSlippageFraction: number,
): boolean {
  if (!Number.isFinite(maxSlippageFraction) || maxSlippageFraction < 0) {
    throw new RangeError("maxSlippageFraction must be finite and >= 0");
  }
  return (
    markSlippageDistance(candidatePrice, markPrice) <= maxSlippageFraction
  );
}
