import type { AppConfig } from "../../config/schema";
import type { GuardianConfig } from "../guardian/config";
import { guardianConfigFromApp } from "../guardian/config";

export type TrendConfig = GuardianConfig & {
  tradeQuantity: number;
  smaPeriod: number;
  bollingerLength: number;
  bollingerMultiplier: number;
  minBandwidth: number;
  entryCooldownMs: number;
};

export function trendConfigFromApp(config: AppConfig): TrendConfig {
  return {
    ...guardianConfigFromApp(config),
    tradeQuantity: config.tradeQuantity,
    smaPeriod: config.trendSmaPeriod,
    bollingerLength: config.trendBollingerLength,
    bollingerMultiplier: config.trendBollingerMultiplier,
    minBandwidth: config.trendMinBandwidth,
    entryCooldownMs: config.trendEntryCooldownMs,
  };
}
