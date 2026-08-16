import type { OrderSide } from "./order";
import type { SymbolPrecision } from "./strategy";

function incrementDecimals(increment: number): number {
  const exponential = increment.toExponential();
  const [mantissa, exponentPart] = exponential.split("e");
  const exponent = Number(exponentPart);
  const dot = mantissa.indexOf(".");
  const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, mantissaDecimals - exponent);
}

const ALIGN_EPSILON = 1e-10;

function requirePositiveIncrement(name: string, increment: number): void {
  if (!Number.isFinite(increment) || increment <= 0) {
    throw new RangeError(`${name} must be finite and greater than 0`);
  }
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

function alignedTicks(value: number, increment: number): number {
  const ticks = value / increment;
  const nearest = Math.round(ticks);
  const tolerance = ALIGN_EPSILON * Math.max(1, Math.abs(nearest));
  if (Math.abs(ticks - nearest) <= tolerance) {
    return nearest;
  }
  return ticks;
}

function fromTicks(ticks: number, increment: number): number {
  const decimals = incrementDecimals(increment);
  const scaledIncrement = Math.round(increment * 10 ** decimals);
  return (ticks * scaledIncrement) / 10 ** decimals;
}

export function roundDownToStep(value: number, stepSize: number): number {
  requireFinite("value", value);
  requirePositiveIncrement("stepSize", stepSize);
  return fromTicks(Math.floor(alignedTicks(value, stepSize)), stepSize);
}

export function roundToTick(
  price: number,
  tickSize: number,
  direction: "down" | "up",
): number {
  requireFinite("price", price);
  requirePositiveIncrement("tickSize", tickSize);
  const ticks = alignedTicks(price, tickSize);
  const rounded = direction === "down" ? Math.floor(ticks) : Math.ceil(ticks);
  return fromTicks(rounded, tickSize);
}

export function roundMakerPrice(
  price: number,
  side: OrderSide,
  precision: SymbolPrecision,
): number {
  return roundToTick(price, precision.tickSize, side === "BUY" ? "down" : "up");
}

export function quantityStep(
  precision: SymbolPrecision,
  orderKind: "limit" | "market" = "limit",
): number {
  if (
    orderKind === "market" &&
    precision.marketStepSize !== undefined &&
    precision.marketStepSize > 0
  ) {
    return precision.marketStepSize;
  }
  return precision.stepSize;
}

export function roundEntryQuantity(
  quantity: number,
  precision: SymbolPrecision,
  orderKind: "limit" | "market" = "limit",
): number {
  requireFinite("quantity", quantity);
  if (quantity <= 0) {
    throw new RangeError("entry quantity must be greater than 0");
  }
  return roundDownToStep(quantity, quantityStep(precision, orderKind));
}

export function roundCloseQuantity(
  requested: number,
  absPosition: number,
  precision: SymbolPrecision,
  orderKind: "limit" | "market" = "limit",
): number {
  requireFinite("requested", requested);
  requireFinite("absPosition", absPosition);
  if (requested < 0) {
    throw new RangeError("close quantity must be >= 0");
  }
  if (absPosition < 0) {
    throw new RangeError("absPosition must be >= 0");
  }
  const capped = Math.min(requested, absPosition);
  return roundDownToStep(capped, quantityStep(precision, orderKind));
}

export function notional(quantity: number, price: number): number {
  requireFinite("quantity", quantity);
  requireFinite("price", price);
  return Math.abs(quantity) * price;
}

export function meetsMinNotional(
  quantity: number,
  price: number,
  precision: SymbolPrecision,
): boolean {
  requireFinite("minNotional", precision.minNotional);
  if (precision.minNotional < 0) {
    throw new RangeError("minNotional must be >= 0");
  }
  return notional(quantity, price) >= precision.minNotional;
}

export function isSendableQuantity(quantity: number): boolean {
  return Number.isFinite(quantity) && quantity > 0;
}
