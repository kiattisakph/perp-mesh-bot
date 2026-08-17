import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateProductionChecklist,
  prepareStartup,
  type ApiKeyAttestation,
} from "../../src/application/production";
import type { EnvSource } from "../../src/config/env";

function exampleEnv(): EnvSource {
  const text = readFileSync(".env.example", "utf8");
  const env: EnvSource = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

const attested: ApiKeyAttestation = {
  futuresEnabled: true,
  withdrawalDisabled: true,
  ipAllowlistEnabled: true,
  prodKeyDistinctFromTestnet: true,
};

describe("production checklist", () => {
  it("passes IP allowlist and API key items when attested on testnet defaults", () => {
    const env = exampleEnv();
    const startup = prepareStartup(["--dry-run", "--testnet"], env);
    const result = evaluateProductionChecklist({
      env,
      appEnv: startup.config.appEnv,
      binanceTestnet: startup.venue === "testnet",
      confirmProduction: startup.flags.confirmProduction,
      restBase: startup.restBase,
      wsBase: startup.wsBase,
      tlsRejectUnauthorized: env.NODE_TLS_REJECT_UNAUTHORIZED,
      attestation: attested,
    });
    expect(result.passed).toBe(true);
    expect(result.items.notSatisfiedByDefaultEnv).toBe(true);
    expect(result.items.ipAllowlistOn).toBe(true);
    expect(result.items.withdrawalOff).toBe(true);
    expect(result.items.apiKeyFuturesEnabled).toBe(true);
    expect(result.items.prodKeyDistinctFromTestnet).toBe(true);
  });

  it("fails when withdrawal is on or IP allowlist is off", () => {
    const env = exampleEnv();
    const startup = prepareStartup(["--testnet"], env);
    const result = evaluateProductionChecklist({
      env,
      appEnv: startup.config.appEnv,
      binanceTestnet: true,
      confirmProduction: false,
      restBase: startup.restBase,
      wsBase: startup.wsBase,
      tlsRejectUnauthorized: undefined,
      attestation: {
        ...attested,
        withdrawalDisabled: false,
        ipAllowlistEnabled: false,
      },
    });
    expect(result.passed).toBe(false);
    expect(result.failed).toContain("withdrawal_permission");
    expect(result.failed).toContain("ip_allowlist");
  });

  it("fails production without confirmation even when keys are attested", () => {
    const env = exampleEnv();
    const result = evaluateProductionChecklist({
      env,
      appEnv: "production",
      binanceTestnet: false,
      confirmProduction: false,
      restBase: "https://fapi.binance.com",
      wsBase: "wss://fstream.binance.com",
      tlsRejectUnauthorized: undefined,
      attestation: attested,
    });
    expect(result.passed).toBe(false);
    expect(result.failed).toContain("production_confirmation");
  });
});
