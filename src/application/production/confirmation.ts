import type { AppEnvName } from "../../config/schema";
import type { EnvSource } from "../../config/env";

/**
 * CLI-only production confirmation. Not an env var, so `.env.example` and
 * `APP_ENV=production` / `BINANCE_TESTNET=false` cannot satisfy it.
 *
 * Roadmap/PRD mark the exact flag name TBD. This identifier is the requirement
 * text ("explicit production confirmation") in the existing CLI flag style.
 */
export const CONFIRM_PRODUCTION_FLAG = "--confirm-production";

export class ProductionConfirmationError extends Error {
  constructor(
    message = `production hosts require ${CONFIRM_PRODUCTION_FLAG}; defaults stay testnet/dry-run`,
  ) {
    super(message);
    this.name = "ProductionConfirmationError";
  }
}

export type ProductionAccessInput = {
  binanceTestnet: boolean;
  appEnv: AppEnvName;
  confirmProduction: boolean;
  readOnly: boolean;
  dryRunFlag: boolean;
};

export type ProductionAccess = {
  venue: "testnet" | "production";
  dryRun: boolean;
  readOnly: boolean;
  placeOrders: boolean;
};

export function envSatisfiesProductionConfirmation(_env: EnvSource): false {
  return false;
}

export function resolveDryRun(input: {
  dryRunFlag: boolean;
  confirmProduction: boolean;
  testnet: boolean;
}): boolean {
  return input.dryRunFlag || input.testnet || !input.confirmProduction;
}

export function resolveProductionAccess(
  input: ProductionAccessInput,
): ProductionAccess {
  void input.appEnv;
  const testnet = input.binanceTestnet;
  if (!testnet && !input.confirmProduction) {
    throw new ProductionConfirmationError();
  }
  const dryRun = resolveDryRun({
    dryRunFlag: input.dryRunFlag,
    confirmProduction: input.confirmProduction,
    testnet,
  });
  const readOnly = input.readOnly;
  return {
    venue: testnet ? "testnet" : "production",
    dryRun,
    readOnly,
    placeOrders: !readOnly && !dryRun,
  };
}

export function skipPlacesReason(
  access: ProductionAccess,
): "read-only" | "dry-run" | undefined {
  if (access.readOnly) {
    return "read-only";
  }
  if (access.dryRun) {
    return "dry-run";
  }
  return undefined;
}
