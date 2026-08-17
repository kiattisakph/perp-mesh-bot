import type { AppConfig, StrategyName } from "../../config/schema";

export type MakerVariant = "classic" | "offset" | "liquidity";

export type MakerConfig = {
  variant: MakerVariant;
  tradeQuantity: number;
  lossLimitUsdt: number;
  maxCloseSlippageFraction: number;
  feedStaleMs: number;
  entryDepthLevel: number;
  bidOffset: number;
  askOffset: number;
  repriceTicks: number;
  minDwellMs: number;
  depthLevels: number;
  skipRatio: number;
  forcedExitRatio: number;
  closeTickOffset: number;
  recentFillMs: number;
};

export function makerVariantFromStrategy(
  strategy: StrategyName,
): MakerVariant | undefined {
  switch (strategy) {
    case "maker":
      return "classic";
    case "offset-maker":
      return "offset";
    case "liquidity-maker":
      return "liquidity";
    default:
      return undefined;
  }
}

export function makerConfigFromApp(config: AppConfig): MakerConfig {
  const variant = makerVariantFromStrategy(config.strategy);
  if (variant === undefined) {
    throw new RangeError(
      `makerConfigFromApp requires STRATEGY maker | offset-maker | liquidity-maker`,
    );
  }
  return {
    variant,
    tradeQuantity: config.tradeQuantity,
    lossLimitUsdt: config.lossLimitUsdt,
    maxCloseSlippageFraction: config.maxCloseSlippageFraction,
    feedStaleMs: config.feedStaleMs,
    entryDepthLevel: config.makerEntryDepthLevel,
    bidOffset: config.makerBidOffset,
    askOffset: config.makerAskOffset,
    repriceTicks: config.makerRepriceTicks,
    minDwellMs: config.makerMinDwellMs,
    depthLevels: config.makerDepthLevels,
    skipRatio:
      variant === "liquidity"
        ? config.liquiditySkipRatio
        : config.offsetSkipRatio,
    forcedExitRatio: config.offsetForcedExitRatio,
    closeTickOffset: config.liquidityCloseTickOffset,
    recentFillMs: config.liquidityRecentFillMs,
  };
}

export function makerConfigForVariant(
  base: MakerConfig,
  variant: MakerVariant,
): MakerConfig {
  return { ...base, variant };
}
