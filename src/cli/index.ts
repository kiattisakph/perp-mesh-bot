import { ConfigError } from "../config/env";
import { emitStrategyLog } from "../application/logger";
import {
  ProductionConfirmationError,
  prepareStartup,
  skipPlacesReason,
} from "../application/production";

export { parseCliFlags } from "./flags";
export type { CliFlags } from "./flags";

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  write?: (line: string) => void,
): Promise<number> {
  try {
    const startup = prepareStartup(argv, env);
    const strategyId = startup.flags.strategy ?? startup.config.strategy;
    const symbol = startup.flags.symbol ?? startup.config.binanceSymbol;
    emitStrategyLog(
      {
        timestamp: new Date().toISOString(),
        level: "info",
        strategyId,
        instanceId: startup.config.instanceId,
        symbol,
        event: "startup",
        details: {
          venue: startup.venue,
          dryRun: startup.dryRun,
          readOnly: startup.readOnly,
          placeOrders: startup.placeOrders,
          skipPlacesReason: skipPlacesReason(startup),
          shutdownMode: startup.shutdownMode,
          restHost: new URL(startup.restBase).hostname,
          wsHost: new URL(startup.wsBase).hostname,
          confirmProduction: startup.flags.confirmProduction,
        },
      },
      write,
    );
    return 0;
  } catch (error) {
    const message =
      error instanceof ProductionConfirmationError || error instanceof ConfigError
        ? error.message
        : "startup_failed";
    emitStrategyLog(
      {
        timestamp: new Date().toISOString(),
        level: "error",
        strategyId: env.STRATEGY ?? "unknown",
        instanceId: env.INSTANCE_ID ?? "unknown",
        symbol: env.BINANCE_SYMBOL ?? "unknown",
        event: "startup_rejected",
        details: { message },
      },
      write,
    );
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
