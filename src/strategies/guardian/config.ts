import type { AppConfig } from "../../config/schema";

export type GuardianConfig = Pick<
  AppConfig,
  | "lossLimitUsdt"
  | "trailingActivationProfitUsdt"
  | "trailingCallbackRate"
  | "profitLockTriggerUsdt"
  | "profitLockStepUsdt"
>;

export function guardianConfigFromApp(config: AppConfig): GuardianConfig {
  return {
    lossLimitUsdt: config.lossLimitUsdt,
    trailingActivationProfitUsdt: config.trailingActivationProfitUsdt,
    trailingCallbackRate: config.trailingCallbackRate,
    profitLockTriggerUsdt: config.profitLockTriggerUsdt,
    profitLockStepUsdt: config.profitLockStepUsdt,
  };
}
