import { parseCliFlags, type CliFlags } from "../../cli/flags";
import { parseEnv, type EnvSource } from "../../config/env";
import type { AppConfig } from "../../config/schema";
import {
  PRODUCTION_REST_BASE,
  PRODUCTION_WS_BASE,
  resolveBinanceEndpoints,
} from "../../infrastructure/binance-usdm/endpoints";
import type { ShutdownMode } from "../shutdown-service";
import {
  resolveProductionAccess,
  type ProductionAccess,
} from "./confirmation";

export type StartupMode = ProductionAccess & {
  config: AppConfig;
  flags: CliFlags;
  shutdownMode: ShutdownMode;
  restBase: string;
  wsBase: string;
};

function shutdownMode(flags: CliFlags): ShutdownMode {
  if (flags.cancelOnly) {
    return "cancel-only";
  }
  if (flags.flattenOnExit) {
    return "flatten";
  }
  return "cancel-owned";
}

export function prepareStartup(
  argv: readonly string[],
  env: EnvSource,
): StartupMode {
  const flags = parseCliFlags(argv);
  const config = parseEnv(env);
  const testnet = flags.testnet || config.binanceTestnet;
  const access = resolveProductionAccess({
    binanceTestnet: testnet,
    appEnv: config.appEnv,
    confirmProduction: flags.confirmProduction,
    readOnly: flags.readOnly,
    dryRunFlag: flags.dryRun,
  });
  const endpoints = resolveBinanceEndpoints({
    testnet: access.venue === "testnet",
    restUrl: config.binanceRestUrl,
    wsUrl: config.binanceWsUrl,
  });
  return {
    ...access,
    config,
    flags,
    shutdownMode: shutdownMode(flags),
    restBase: endpoints.restBase,
    wsBase: endpoints.wsBase,
  };
}

export function productionHostsAllowlisted(startup: StartupMode): boolean {
  if (startup.venue !== "production") {
    return true;
  }
  return (
    startup.restBase === PRODUCTION_REST_BASE &&
    startup.wsBase === PRODUCTION_WS_BASE
  );
}
