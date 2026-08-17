export function usdStopPrice(input: {
  entryPrice: number;
  quantity: number;
  lossUsd: number;
}): number {
  const { entryPrice, quantity, lossUsd } = input;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new RangeError("entryPrice must be finite and greater than 0");
  }
  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new RangeError("quantity must be a non-zero finite number");
  }
  if (!Number.isFinite(lossUsd) || lossUsd <= 0) {
    throw new RangeError("lossUsd must be finite and greater than 0");
  }
  if (quantity > 0) {
    return entryPrice - lossUsd / quantity;
  }
  return entryPrice + lossUsd / Math.abs(quantity);
}

export function percentStopPrice(input: {
  entryPrice: number;
  quantity: number;
  stopLossFraction: number;
}): number {
  const { entryPrice, quantity, stopLossFraction } = input;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new RangeError("entryPrice must be finite and greater than 0");
  }
  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new RangeError("quantity must be a non-zero finite number");
  }
  if (!Number.isFinite(stopLossFraction) || stopLossFraction <= 0) {
    throw new RangeError("stopLossFraction must be finite and greater than 0");
  }
  if (quantity > 0) {
    return entryPrice * (1 - stopLossFraction);
  }
  return entryPrice * (1 + stopLossFraction);
}

export function isRiskReducingStopMove(input: {
  quantity: number;
  previousStop: number;
  nextStop: number;
}): boolean {
  const { quantity, previousStop, nextStop } = input;
  if (!Number.isFinite(previousStop) || !Number.isFinite(nextStop)) {
    throw new RangeError("stop prices must be finite");
  }
  if (!Number.isFinite(quantity) || quantity === 0) {
    throw new RangeError("quantity must be a non-zero finite number");
  }
  if (quantity > 0) {
    return nextStop >= previousStop;
  }
  return nextStop <= previousStop;
}
