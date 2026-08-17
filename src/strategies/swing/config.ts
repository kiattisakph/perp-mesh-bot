import type { AppConfig, SwingDirection } from "../../config/schema";

export type SwingConfig = {
  tradeQuantity: number;
  direction: SwingDirection;
  rsiPeriod: number;
  rsiHigh: number;
  rsiLow: number;
  stopLossFraction: number;
  requireProfitForExit: boolean;
};

export function swingConfigFromApp(config: AppConfig): SwingConfig {
  return {
    tradeQuantity: config.tradeQuantity,
    direction: config.swingDirection,
    rsiPeriod: config.swingRsiPeriod,
    rsiHigh: config.swingRsiHigh,
    rsiLow: config.swingRsiLow,
    stopLossFraction: config.swingStopLossFraction,
    requireProfitForExit: config.swingRequireProfitForExit,
  };
}

export function directionAllows(
  direction: SwingDirection,
  side: "long" | "short",
): boolean {
  return direction === "both" || direction === side;
}
