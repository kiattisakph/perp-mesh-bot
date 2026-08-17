import type { AppEnvName } from "../../config/schema";
import {
  PRODUCTION_REST_BASE,
  PRODUCTION_WS_BASE,
} from "../../infrastructure/binance-usdm/endpoints";
import { envSatisfiesProductionConfirmation } from "./confirmation";
import type { EnvSource } from "../../config/env";

export type ApiKeyAttestation = {
  futuresEnabled: boolean;
  withdrawalDisabled: boolean;
  ipAllowlistEnabled: boolean;
  prodKeyDistinctFromTestnet: boolean;
};

export type ProductionChecklistInput = {
  env: EnvSource;
  appEnv: AppEnvName;
  binanceTestnet: boolean;
  confirmProduction: boolean;
  restBase: string;
  wsBase: string;
  tlsRejectUnauthorized: string | undefined;
  attestation: ApiKeyAttestation;
};

export type ProductionChecklistResult = {
  passed: boolean;
  failed: string[];
  items: {
    notSatisfiedByDefaultEnv: boolean;
    productionConfirmed: boolean;
    productionEndpointsAllowlisted: boolean;
    tlsVerificationOn: boolean;
    apiKeyFuturesEnabled: boolean;
    withdrawalOff: boolean;
    ipAllowlistOn: boolean;
    prodKeyDistinctFromTestnet: boolean;
  };
};

export function evaluateProductionChecklist(
  input: ProductionChecklistInput,
): ProductionChecklistResult {
  void input.appEnv;
  const production = !input.binanceTestnet;
  const endpointsAllowlisted = production
    ? input.restBase === PRODUCTION_REST_BASE &&
      input.wsBase === PRODUCTION_WS_BASE
    : true;
  const items = {
    notSatisfiedByDefaultEnv: !envSatisfiesProductionConfirmation(input.env),
    productionConfirmed: !production || input.confirmProduction,
    productionEndpointsAllowlisted: endpointsAllowlisted,
    tlsVerificationOn: input.tlsRejectUnauthorized !== "0",
    apiKeyFuturesEnabled: input.attestation.futuresEnabled,
    withdrawalOff: input.attestation.withdrawalDisabled,
    ipAllowlistOn: input.attestation.ipAllowlistEnabled,
    prodKeyDistinctFromTestnet: input.attestation.prodKeyDistinctFromTestnet,
  };
  const failed: string[] = [];
  if (!items.notSatisfiedByDefaultEnv) {
    failed.push("default_env_confirms_production");
  }
  if (production && !input.confirmProduction) {
    failed.push("production_confirmation");
  }
  if (!items.productionEndpointsAllowlisted) {
    failed.push("endpoint_allowlist");
  }
  if (!items.tlsVerificationOn) {
    failed.push("tls_verification");
  }
  if (!items.apiKeyFuturesEnabled) {
    failed.push("api_key_futures");
  }
  if (!items.withdrawalOff) {
    failed.push("withdrawal_permission");
  }
  if (!items.ipAllowlistOn) {
    failed.push("ip_allowlist");
  }
  if (!items.prodKeyDistinctFromTestnet) {
    failed.push("prod_key_equals_testnet_key");
  }
  return {
    passed: failed.length === 0,
    failed,
    items,
  };
}
