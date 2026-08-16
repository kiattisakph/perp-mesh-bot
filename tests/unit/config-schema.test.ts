import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, parseEnv, type EnvSource } from "../../src/config/env";

const domainDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/domain",
);

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

describe("config schema", () => {
  it("parses the documented .env.example values", () => {
    const config = parseEnv(exampleEnv());
    expect(config.appEnv).toBe("development");
    expect(config.strategy).toBe("guardian");
    expect(config.binanceTestnet).toBe(true);
    expect(config.binanceMarginMode).toBe("isolated");
    expect(config.binanceLeverage).toBe(3);
    expect(config.binanceRequireOneWay).toBe(true);
    expect(config.killSwitchMode).toBe("CANCEL_AND_FLATTEN");
    expect(config.trailingCallbackRate).toBe(0.2);
    expect(config.swingRsiLow).toBe(30);
    expect(config.swingRsiHigh).toBe(70);
    expect(config.swingSignalMarket).toBe("usdm");
    expect(config.makerBidOffset).toBe(0);
    expect(config.binanceApiKey).toBe("");
    expect(config.binanceApiSecret).toBe("");
  });

  it("fails fast on invalid numbers, RSI order, callback rate, and leverage", () => {
    const env = exampleEnv();
    env.TRADE_QUANTITY = "0";
    env.SWING_RSI_LOW = "80";
    env.SWING_RSI_HIGH = "70";
    env.TRAILING_CALLBACK_RATE = "6";
    env.BINANCE_LEVERAGE = "0";

    expect(() => parseEnv(env)).toThrow(ConfigError);
    try {
      parseEnv(env);
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : "";
      expect(message).toMatch(/TRADE_QUANTITY/);
      expect(message).toMatch(/SWING_RSI_LOW/);
      expect(message).toMatch(/TRAILING_CALLBACK_RATE/);
      expect(message).toMatch(/BINANCE_LEVERAGE/);
      expect(message).not.toMatch(/api/i);
      expect(message).not.toMatch(/secret/i);
    }
  });

  it("rejects cross margin, spot swing market, and production custom URLs", () => {
    const env = exampleEnv();
    env.BINANCE_MARGIN_MODE = "cross";
    env.SWING_SIGNAL_MARKET = "spot";
    env.BINANCE_TESTNET = "false";
    env.BINANCE_REST_URL = "https://example.invalid";

    expect(() => parseEnv(env)).toThrow(ConfigError);
    try {
      parseEnv(env);
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : "";
      expect(message).toMatch(/isolated/);
      expect(message).toMatch(/usdm/);
      expect(message).toMatch(/testnet-only/);
    }
  });

  it("allows HTTPS/WSS custom endpoints only on testnet", () => {
    const env = exampleEnv();
    env.BINANCE_REST_URL = "https://demo-fapi.example.test";
    env.BINANCE_WS_URL = "wss://fstream.example.test";
    const config = parseEnv(env);
    expect(config.binanceRestUrl).toBe("https://demo-fapi.example.test");
    expect(config.binanceWsUrl).toBe("wss://fstream.example.test");
  });

  it("rejects TLS verification bypass", () => {
    const env = exampleEnv();
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    expect(() => parseEnv(env)).toThrow(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});

describe("domain package boundary", () => {
  it("does not import CCXT or Binance adapter modules", () => {
    const files = readdirSync(domainDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(join(domainDir, name), "utf8");
      expect(source).not.toMatch(/from ["']ccxt["']/);
      expect(source).not.toMatch(/from ["'][^"']*binance-usdm/);
      expect(source).not.toMatch(/from ["']ccxt\//);
    }
  });
});
