import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, type EnvSource } from "../../src/config/env";
import {
  CONFIRM_PRODUCTION_FLAG,
  ProductionConfirmationError,
  envSatisfiesProductionConfirmation,
  prepareStartup,
  resolveProductionAccess,
} from "../../src/application/production";
import { parseCliFlags } from "../../src/cli/flags";
import { main } from "../../src/cli/index";

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

describe("production confirmation", () => {
  it("cannot be satisfied by default env", () => {
    const env = exampleEnv();
    expect(envSatisfiesProductionConfirmation(env)).toBe(false);
    expect(env.BINANCE_TESTNET).toBe("true");
    expect(env.APP_ENV).toBe("development");
    const example = readFileSync(".env.example", "utf8");
    expect(example).not.toMatch(/CONFIRM_PRODUCTION\s*=/);
    expect(example).not.toMatch(/confirm-production\s*=\s*true/i);

    const startup = prepareStartup(
      ["--strategy", "guardian", "--symbol", "BTCUSDT", "--dry-run", "--testnet"],
      env,
    );
    expect(startup.venue).toBe("testnet");
    expect(startup.placeOrders).toBe(false);
    expect(startup.flags.confirmProduction).toBe(false);
  });

  it("is not satisfied by APP_ENV=production or BINANCE_TESTNET=false alone", () => {
    const env = exampleEnv();
    env.APP_ENV = "production";
    env.BINANCE_TESTNET = "false";
    expect(envSatisfiesProductionConfirmation(env)).toBe(false);
    expect(() => prepareStartup([], env)).toThrow(ProductionConfirmationError);
    expect(() =>
      resolveProductionAccess({
        binanceTestnet: false,
        appEnv: "production",
        confirmProduction: false,
        readOnly: false,
        dryRunFlag: false,
      }),
    ).toThrow(/--confirm-production/);
  });

  it("allows production hosts only with the CLI confirmation flag", () => {
    const env = exampleEnv();
    env.BINANCE_TESTNET = "false";
    const startup = prepareStartup([CONFIRM_PRODUCTION_FLAG], env);
    expect(startup.venue).toBe("production");
    expect(startup.placeOrders).toBe(true);
    expect(startup.restBase).toBe("https://fapi.binance.com");
    expect(startup.wsBase).toBe("wss://fstream.binance.com");
  });

  it("keeps production dry-run or read-only from placing orders", () => {
    const env = exampleEnv();
    env.BINANCE_TESTNET = "false";
    const dry = prepareStartup(
      [CONFIRM_PRODUCTION_FLAG, "--dry-run"],
      env,
    );
    expect(dry.venue).toBe("production");
    expect(dry.placeOrders).toBe(false);
    const readOnly = prepareStartup(
      [CONFIRM_PRODUCTION_FLAG, "--read-only"],
      env,
    );
    expect(readOnly.placeOrders).toBe(false);
    expect(readOnly.readOnly).toBe(true);
  });
});

describe("cli flags", () => {
  it("parses documented safety flags", () => {
    const flags = parseCliFlags([
      "--strategy",
      "trend",
      "--symbol",
      "ETHUSDT",
      "--dry-run",
      "--testnet",
      "--read-only",
    ]);
    expect(flags.strategy).toBe("trend");
    expect(flags.symbol).toBe("ETHUSDT");
    expect(flags.dryRun).toBe(true);
    expect(flags.testnet).toBe(true);
    expect(flags.readOnly).toBe(true);
    expect(flags.confirmProduction).toBe(false);
  });

  it("rejects --cancel-only together with --flatten-on-exit", () => {
    expect(() =>
      parseCliFlags(["--cancel-only", "--flatten-on-exit"]),
    ).toThrow(ConfigError);
  });
});

describe("cli main", () => {
  it("exits 0 on default testnet dry-run and 1 without production confirmation", async () => {
    const silent = (): void => undefined;
    expect(await main(["--dry-run", "--testnet"], exampleEnv(), silent)).toBe(0);
    const live = exampleEnv();
    live.BINANCE_TESTNET = "false";
    expect(await main([], live, silent)).toBe(1);
  });
});
