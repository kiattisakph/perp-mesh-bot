export type AppEnvName = "development" | "production";

export type StrategyName =
  | "guardian"
  | "trend"
  | "swing"
  | "maker"
  | "offset-maker"
  | "liquidity-maker";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type KillSwitchMode = "CANCEL_ONLY" | "CANCEL_AND_FLATTEN";

export type SwingDirection = "long" | "short" | "both";

export type KlineInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "8h"
  | "12h"
  | "1d"
  | "3d"
  | "1w"
  | "1M";

export type AppConfig = {
  appEnv: AppEnvName;
  strategy: StrategyName;
  instanceId: string;
  logLevel: LogLevel;
  binanceApiKey: string;
  binanceApiSecret: string;
  binanceSymbol: string;
  binanceTestnet: boolean;
  binanceMarginMode: "isolated";
  binanceLeverage: number;
  binanceRequireOneWay: boolean;
  binanceRestUrl?: string;
  binanceWsUrl?: string;
  accountPollMs: number;
  ordersPollMs: number;
  feedStaleMs: number;
  reconnectMaxMs: number;
  tradeQuantity: number;
  maxPositionQuantity: number;
  maxNotionalUsdt: number;
  maxCloseSlippageFraction: number;
  sessionLossLimitUsdt: number;
  killSwitchMode: KillSwitchMode;
  lossLimitUsdt: number;
  trailingActivationProfitUsdt: number;
  trailingCallbackRate: number;
  profitLockTriggerUsdt: number;
  profitLockStepUsdt: number;
  trendSmaPeriod: number;
  trendKlineInterval: KlineInterval;
  trendBollingerLength: number;
  trendBollingerMultiplier: number;
  trendMinBandwidth: number;
  trendEntryCooldownMs: number;
  swingDirection: SwingDirection;
  swingRsiPeriod: number;
  swingRsiHigh: number;
  swingRsiLow: number;
  swingSignalSymbol: string;
  swingSignalInterval: KlineInterval;
  swingSignalMarket: "usdm";
  swingStopLossFraction: number;
  swingRequireProfitForExit: boolean;
  makerRefreshMs: number;
  makerEntryDepthLevel: number;
  makerBidOffset: number;
  makerAskOffset: number;
  makerRepriceTicks: number;
  makerMinDwellMs: number;
  makerDepthLevels: number;
  offsetSkipRatio: number;
  offsetForcedExitRatio: number;
  liquiditySkipRatio: number;
  liquidityCloseTickOffset: number;
  liquidityRecentFillMs: number;
};

export const STRATEGY_NAMES: readonly StrategyName[] = [
  "guardian",
  "trend",
  "swing",
  "maker",
  "offset-maker",
  "liquidity-maker",
];

export const KLINE_INTERVALS: readonly KlineInterval[] = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M",
];

export const TRAILING_CALLBACK_RATE_MIN = 0.1;
export const TRAILING_CALLBACK_RATE_MAX = 5;
export const LEVERAGE_MIN = 1;
export const LEVERAGE_MAX = 125;
