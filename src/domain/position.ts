import type { OrderSide } from "./order";

export type PositionDirection = "flat" | "long" | "short";

export function isFlat(quantity: number): boolean {
  return quantity === 0;
}

export function isLong(quantity: number): boolean {
  return quantity > 0;
}

export function isShort(quantity: number): boolean {
  return quantity < 0;
}

export function absQuantity(quantity: number): number {
  return Math.abs(quantity);
}

export function positionDirection(quantity: number): PositionDirection {
  if (isFlat(quantity)) {
    return "flat";
  }
  return isLong(quantity) ? "long" : "short";
}

export function closeSide(quantity: number): OrderSide {
  if (isFlat(quantity)) {
    throw new RangeError("flat position has no close side");
  }
  return isLong(quantity) ? "SELL" : "BUY";
}

export function entrySide(direction: "long" | "short"): OrderSide {
  return direction === "long" ? "BUY" : "SELL";
}
