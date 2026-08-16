import {
  KLINE_INTERVALS,
  LEVERAGE_MAX,
  LEVERAGE_MIN,
  STRATEGY_NAMES,
  TRAILING_CALLBACK_RATE_MAX,
  TRAILING_CALLBACK_RATE_MIN,
  type AppConfig,
  type AppEnvName,
  type KillSwitchMode,
  type LogLevel,
  type SwingDirection,
} from "./schema";

export class ConfigError extends Error {
  readonly fields: readonly string[];

  constructor(message: string, fields: readonly string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.fields = fields;
  }
}

export type EnvSource = Record<string, string | undefined>;

const APP_ENVS: readonly AppEnvName[] = ["development", "production"];
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const KILL_SWITCH_MODES: readonly KillSwitchMode[] = [
  "CANCEL_ONLY",
  "CANCEL_AND_FLATTEN",
];
const SWING_DIRECTIONS: readonly SwingDirection[] = ["long", "short", "both"];
const INSTANCE_ID_PATTERN = /^[.A-Z:/a-z0-9_-]+$/;
const USDTM_SYMBOL_PATTERN = /^[A-Z0-9]+USDT$/;

function required(env: EnvSource, name: string): string {
  const value = env[name];
  if (value === undefined) {
    throw new ConfigError(`${name} is required`, [name]);
  }
  return value;
}

function optional(env: EnvSource, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

function parseEnum<T extends string>(
  name: string,
  value: string,
  allowed: readonly T[],
): T {
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new ConfigError(
    `${name} must be one of: ${allowed.join(", ")}`,
    [name],
  );
}

function parseBoolean(name: string, value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ConfigError(`${name} must be true or false`, [name]);
}

function parseFiniteNumber(name: string, value: string): number {
  if (value.trim() === "") {
    throw new ConfigError(`${name} must be a finite number`, [name]);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a finite number`, [name]);
  }
  return parsed;
}

function parsePositiveNumber(name: string, value: string): number {
  const parsed = parseFiniteNumber(name, value);
  if (parsed <= 0) {
    throw new ConfigError(`${name} must be greater than 0`, [name]);
  }
  return parsed;
}

function parseNonNegativeNumber(name: string, value: string): number {
  const parsed = parseFiniteNumber(name, value);
  if (parsed < 0) {
    throw new ConfigError(`${name} must be greater than or equal to 0`, [name]);
  }
  return parsed;
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = parsePositiveNumber(name, value);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${name} must be an integer greater than 0`, [name]);
  }
  return parsed;
}

function parseNonNegativeInteger(name: string, value: string): number {
  const parsed = parseNonNegativeNumber(name, value);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(
      `${name} must be an integer greater than or equal to 0`,
      [name],
    );
  }
  return parsed;
}

function parseUsdtmSymbol(name: string, value: string): string {
  const symbol = value.trim().toUpperCase();
  if (symbol.includes("_PERP")) {
    throw new ConfigError(
      `${name} must be a USDT-M perpetual symbol without a _PERP suffix`,
      [name],
    );
  }
  if (!USDTM_SYMBOL_PATTERN.test(symbol)) {
    throw new ConfigError(
      `${name} must be a USDT-M perpetual symbol such as BTCUSDT`,
      [name],
    );
  }
  return symbol;
}

function parseInstanceId(value: string): string {
  if (value.trim() === "") {
    throw new ConfigError("INSTANCE_ID must be non-empty", ["INSTANCE_ID"]);
  }
  if (!INSTANCE_ID_PATTERN.test(value)) {
    throw new ConfigError(
      "INSTANCE_ID must match Binance newClientOrderId charset",
      ["INSTANCE_ID"],
    );
  }
  return value;
}

function parseHttpsUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid HTTPS URL`, [name]);
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(`${name} must use HTTPS`, [name]);
  }
  if (url.hostname.trim() === "") {
    throw new ConfigError(`${name} must include a hostname`, [name]);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(`${name} must not include credentials`, [name]);
  }
  return value;
}

function parseWssUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid WSS URL`, [name]);
  }
  if (url.protocol !== "wss:") {
    throw new ConfigError(`${name} must use WSS`, [name]);
  }
  if (url.hostname.trim() === "") {
    throw new ConfigError(`${name} must include a hostname`, [name]);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(`${name} must not include credentials`, [name]);
  }
  return value;
}

function parseCallbackRate(value: string): number {
  const parsed = parseFiniteNumber("TRAILING_CALLBACK_RATE", value);
  if (
    parsed < TRAILING_CALLBACK_RATE_MIN ||
    parsed > TRAILING_CALLBACK_RATE_MAX
  ) {
    throw new ConfigError(
      `TRAILING_CALLBACK_RATE must be between ${TRAILING_CALLBACK_RATE_MIN} and ${TRAILING_CALLBACK_RATE_MAX}`,
      ["TRAILING_CALLBACK_RATE"],
    );
  }
  return parsed;
}

function parseLeverage(value: string): number {
  const parsed = parsePositiveInteger("BINANCE_LEVERAGE", value);
  if (parsed < LEVERAGE_MIN || parsed > LEVERAGE_MAX) {
    throw new ConfigError(
      `BINANCE_LEVERAGE must be an integer from ${LEVERAGE_MIN} to ${LEVERAGE_MAX}`,
      ["BINANCE_LEVERAGE"],
    );
  }
  return parsed;
}

function parseRsiThreshold(name: string, value: string): number {
  const parsed = parseFiniteNumber(name, value);
  if (parsed < 0 || parsed > 100) {
    throw new ConfigError(`${name} must be between 0 and 100`, [name]);
  }
  return parsed;
}

export function parseEnv(env: EnvSource): AppConfig {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ConfigError(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed",
      ["NODE_TLS_REJECT_UNAUTHORIZED"],
    );
  }

  const errors: string[] = [];
  const fields: string[] = [];

  const collect = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch (error) {
      if (error instanceof ConfigError) {
        errors.push(error.message);
        fields.push(...error.fields);
        return undefined;
      }
      throw error;
    }
  };

  const appEnv = collect(() =>
    parseEnum("APP_ENV", required(env, "APP_ENV"), APP_ENVS),
  );
  const strategy = collect(() =>
    parseEnum("STRATEGY", required(env, "STRATEGY"), STRATEGY_NAMES),
  );
  const instanceId = collect(() => parseInstanceId(required(env, "INSTANCE_ID")));
  const logLevel = collect(() =>
    parseEnum("LOG_LEVEL", required(env, "LOG_LEVEL"), LOG_LEVELS),
  );

  const binanceApiKey = env.BINANCE_API_KEY ?? "";
  const binanceApiSecret = env.BINANCE_API_SECRET ?? "";

  const binanceSymbol = collect(() =>
    parseUsdtmSymbol("BINANCE_SYMBOL", required(env, "BINANCE_SYMBOL")),
  );
  const binanceTestnet = collect(() =>
    parseBoolean("BINANCE_TESTNET", required(env, "BINANCE_TESTNET")),
  );
  const binanceMarginMode = collect(() => {
    const value = required(env, "BINANCE_MARGIN_MODE");
    if (value !== "isolated") {
      throw new ConfigError(
        "BINANCE_MARGIN_MODE must be isolated (v1 requires Isolated Margin)",
        ["BINANCE_MARGIN_MODE"],
      );
    }
    return "isolated" as const;
  });
  const binanceLeverage = collect(() =>
    parseLeverage(required(env, "BINANCE_LEVERAGE")),
  );
  const binanceRequireOneWay = collect(() =>
    parseBoolean(
      "BINANCE_REQUIRE_ONE_WAY",
      required(env, "BINANCE_REQUIRE_ONE_WAY"),
    ),
  );

  const restUrlRaw = optional(env, "BINANCE_REST_URL");
  const wsUrlRaw = optional(env, "BINANCE_WS_URL");
  const binanceRestUrl = collect(() =>
    restUrlRaw === undefined ? undefined : parseHttpsUrl("BINANCE_REST_URL", restUrlRaw),
  );
  const binanceWsUrl = collect(() =>
    wsUrlRaw === undefined ? undefined : parseWssUrl("BINANCE_WS_URL", wsUrlRaw),
  );

  if (
    binanceTestnet === false &&
    (restUrlRaw !== undefined || wsUrlRaw !== undefined)
  ) {
    errors.push("custom BINANCE_REST_URL / BINANCE_WS_URL are testnet-only");
    if (restUrlRaw !== undefined) {
      fields.push("BINANCE_REST_URL");
    }
    if (wsUrlRaw !== undefined) {
      fields.push("BINANCE_WS_URL");
    }
  }

  const accountPollMs = collect(() =>
    parsePositiveInteger("ACCOUNT_POLL_MS", required(env, "ACCOUNT_POLL_MS")),
  );
  const ordersPollMs = collect(() =>
    parsePositiveInteger("ORDERS_POLL_MS", required(env, "ORDERS_POLL_MS")),
  );
  const feedStaleMs = collect(() =>
    parsePositiveInteger("FEED_STALE_MS", required(env, "FEED_STALE_MS")),
  );
  const reconnectMaxMs = collect(() =>
    parsePositiveInteger("RECONNECT_MAX_MS", required(env, "RECONNECT_MAX_MS")),
  );

  const tradeQuantity = collect(() =>
    parsePositiveNumber("TRADE_QUANTITY", required(env, "TRADE_QUANTITY")),
  );
  const maxPositionQuantity = collect(() =>
    parsePositiveNumber(
      "MAX_POSITION_QUANTITY",
      required(env, "MAX_POSITION_QUANTITY"),
    ),
  );
  const maxNotionalUsdt = collect(() =>
    parsePositiveNumber("MAX_NOTIONAL_USDT", required(env, "MAX_NOTIONAL_USDT")),
  );
  const maxCloseSlippageFraction = collect(() =>
    parsePositiveNumber(
      "MAX_CLOSE_SLIPPAGE_FRACTION",
      required(env, "MAX_CLOSE_SLIPPAGE_FRACTION"),
    ),
  );
  const sessionLossLimitUsdt = collect(() =>
    parsePositiveNumber(
      "SESSION_LOSS_LIMIT_USDT",
      required(env, "SESSION_LOSS_LIMIT_USDT"),
    ),
  );
  const killSwitchMode = collect(() =>
    parseEnum(
      "KILL_SWITCH_MODE",
      required(env, "KILL_SWITCH_MODE"),
      KILL_SWITCH_MODES,
    ),
  );

  const lossLimitUsdt = collect(() =>
    parsePositiveNumber("LOSS_LIMIT_USDT", required(env, "LOSS_LIMIT_USDT")),
  );
  const trailingActivationProfitUsdt = collect(() =>
    parsePositiveNumber(
      "TRAILING_ACTIVATION_PROFIT_USDT",
      required(env, "TRAILING_ACTIVATION_PROFIT_USDT"),
    ),
  );
  const trailingCallbackRate = collect(() =>
    parseCallbackRate(required(env, "TRAILING_CALLBACK_RATE")),
  );
  const profitLockTriggerUsdt = collect(() =>
    parsePositiveNumber(
      "PROFIT_LOCK_TRIGGER_USDT",
      required(env, "PROFIT_LOCK_TRIGGER_USDT"),
    ),
  );
  const profitLockStepUsdt = collect(() =>
    parsePositiveNumber(
      "PROFIT_LOCK_STEP_USDT",
      required(env, "PROFIT_LOCK_STEP_USDT"),
    ),
  );
  const trendSmaPeriod = collect(() =>
    parsePositiveInteger("TREND_SMA_PERIOD", required(env, "TREND_SMA_PERIOD")),
  );
  const trendKlineInterval = collect(() =>
    parseEnum(
      "TREND_KLINE_INTERVAL",
      required(env, "TREND_KLINE_INTERVAL"),
      KLINE_INTERVALS,
    ),
  );
  const trendBollingerLength = collect(() =>
    parsePositiveInteger(
      "TREND_BOLLINGER_LENGTH",
      required(env, "TREND_BOLLINGER_LENGTH"),
    ),
  );
  const trendBollingerMultiplier = collect(() =>
    parsePositiveNumber(
      "TREND_BOLLINGER_MULTIPLIER",
      required(env, "TREND_BOLLINGER_MULTIPLIER"),
    ),
  );
  const trendMinBandwidth = collect(() =>
    parsePositiveNumber(
      "TREND_MIN_BANDWIDTH",
      required(env, "TREND_MIN_BANDWIDTH"),
    ),
  );
  const trendEntryCooldownMs = collect(() =>
    parsePositiveInteger(
      "TREND_ENTRY_COOLDOWN_MS",
      required(env, "TREND_ENTRY_COOLDOWN_MS"),
    ),
  );

  const swingDirection = collect(() =>
    parseEnum(
      "SWING_DIRECTION",
      required(env, "SWING_DIRECTION"),
      SWING_DIRECTIONS,
    ),
  );
  const swingRsiPeriod = collect(() =>
    parsePositiveInteger("SWING_RSI_PERIOD", required(env, "SWING_RSI_PERIOD")),
  );
  const swingRsiHigh = collect(() =>
    parseRsiThreshold("SWING_RSI_HIGH", required(env, "SWING_RSI_HIGH")),
  );
  const swingRsiLow = collect(() =>
    parseRsiThreshold("SWING_RSI_LOW", required(env, "SWING_RSI_LOW")),
  );
  const swingSignalSymbol = collect(() =>
    parseUsdtmSymbol(
      "SWING_SIGNAL_SYMBOL",
      required(env, "SWING_SIGNAL_SYMBOL"),
    ),
  );
  const swingSignalInterval = collect(() =>
    parseEnum(
      "SWING_SIGNAL_INTERVAL",
      required(env, "SWING_SIGNAL_INTERVAL"),
      KLINE_INTERVALS,
    ),
  );
  const swingSignalMarket = collect(() => {
    const value = required(env, "SWING_SIGNAL_MARKET");
    if (value !== "usdm") {
      throw new ConfigError(
        "SWING_SIGNAL_MARKET must be usdm (spot is not implemented in v1)",
        ["SWING_SIGNAL_MARKET"],
      );
    }
    return "usdm" as const;
  });
  const swingStopLossFraction = collect(() =>
    parsePositiveNumber(
      "SWING_STOP_LOSS_FRACTION",
      required(env, "SWING_STOP_LOSS_FRACTION"),
    ),
  );
  const swingRequireProfitForExit = collect(() =>
    parseBoolean(
      "SWING_REQUIRE_PROFIT_FOR_EXIT",
      required(env, "SWING_REQUIRE_PROFIT_FOR_EXIT"),
    ),
  );

  if (
    swingRsiLow !== undefined &&
    swingRsiHigh !== undefined &&
    !(swingRsiLow < swingRsiHigh)
  ) {
    errors.push("SWING_RSI_LOW must be less than SWING_RSI_HIGH");
    fields.push("SWING_RSI_LOW", "SWING_RSI_HIGH");
  }

  const makerRefreshMs = collect(() =>
    parsePositiveInteger("MAKER_REFRESH_MS", required(env, "MAKER_REFRESH_MS")),
  );
  const makerEntryDepthLevel = collect(() =>
    parsePositiveInteger(
      "MAKER_ENTRY_DEPTH_LEVEL",
      required(env, "MAKER_ENTRY_DEPTH_LEVEL"),
    ),
  );
  const makerBidOffset = collect(() =>
    parseNonNegativeNumber("MAKER_BID_OFFSET", required(env, "MAKER_BID_OFFSET")),
  );
  const makerAskOffset = collect(() =>
    parseNonNegativeNumber("MAKER_ASK_OFFSET", required(env, "MAKER_ASK_OFFSET")),
  );
  const makerRepriceTicks = collect(() =>
    parseNonNegativeInteger(
      "MAKER_REPRICE_TICKS",
      required(env, "MAKER_REPRICE_TICKS"),
    ),
  );
  const makerMinDwellMs = collect(() =>
    parsePositiveInteger(
      "MAKER_MIN_DWELL_MS",
      required(env, "MAKER_MIN_DWELL_MS"),
    ),
  );
  const makerDepthLevels = collect(() =>
    parsePositiveInteger(
      "MAKER_DEPTH_LEVELS",
      required(env, "MAKER_DEPTH_LEVELS"),
    ),
  );

  const offsetSkipRatio = collect(() =>
    parsePositiveNumber("OFFSET_SKIP_RATIO", required(env, "OFFSET_SKIP_RATIO")),
  );
  const offsetForcedExitRatio = collect(() =>
    parsePositiveNumber(
      "OFFSET_FORCED_EXIT_RATIO",
      required(env, "OFFSET_FORCED_EXIT_RATIO"),
    ),
  );

  const liquiditySkipRatio = collect(() =>
    parsePositiveNumber(
      "LIQUIDITY_SKIP_RATIO",
      required(env, "LIQUIDITY_SKIP_RATIO"),
    ),
  );
  const liquidityCloseTickOffset = collect(() =>
    parseNonNegativeInteger(
      "LIQUIDITY_CLOSE_TICK_OFFSET",
      required(env, "LIQUIDITY_CLOSE_TICK_OFFSET"),
    ),
  );
  const liquidityRecentFillMs = collect(() =>
    parsePositiveInteger(
      "LIQUIDITY_RECENT_FILL_MS",
      required(env, "LIQUIDITY_RECENT_FILL_MS"),
    ),
  );

  if (errors.length > 0) {
    throw new ConfigError(errors.join("; "), [...new Set(fields)]);
  }

  return {
    appEnv: appEnv!,
    strategy: strategy!,
    instanceId: instanceId!,
    logLevel: logLevel!,
    binanceApiKey,
    binanceApiSecret,
    binanceSymbol: binanceSymbol!,
    binanceTestnet: binanceTestnet!,
    binanceMarginMode: binanceMarginMode!,
    binanceLeverage: binanceLeverage!,
    binanceRequireOneWay: binanceRequireOneWay!,
    ...(binanceRestUrl !== undefined ? { binanceRestUrl } : {}),
    ...(binanceWsUrl !== undefined ? { binanceWsUrl } : {}),
    accountPollMs: accountPollMs!,
    ordersPollMs: ordersPollMs!,
    feedStaleMs: feedStaleMs!,
    reconnectMaxMs: reconnectMaxMs!,
    tradeQuantity: tradeQuantity!,
    maxPositionQuantity: maxPositionQuantity!,
    maxNotionalUsdt: maxNotionalUsdt!,
    maxCloseSlippageFraction: maxCloseSlippageFraction!,
    sessionLossLimitUsdt: sessionLossLimitUsdt!,
    killSwitchMode: killSwitchMode!,
    lossLimitUsdt: lossLimitUsdt!,
    trailingActivationProfitUsdt: trailingActivationProfitUsdt!,
    trailingCallbackRate: trailingCallbackRate!,
    profitLockTriggerUsdt: profitLockTriggerUsdt!,
    profitLockStepUsdt: profitLockStepUsdt!,
    trendSmaPeriod: trendSmaPeriod!,
    trendKlineInterval: trendKlineInterval!,
    trendBollingerLength: trendBollingerLength!,
    trendBollingerMultiplier: trendBollingerMultiplier!,
    trendMinBandwidth: trendMinBandwidth!,
    trendEntryCooldownMs: trendEntryCooldownMs!,
    swingDirection: swingDirection!,
    swingRsiPeriod: swingRsiPeriod!,
    swingRsiHigh: swingRsiHigh!,
    swingRsiLow: swingRsiLow!,
    swingSignalSymbol: swingSignalSymbol!,
    swingSignalInterval: swingSignalInterval!,
    swingSignalMarket: swingSignalMarket!,
    swingStopLossFraction: swingStopLossFraction!,
    swingRequireProfitForExit: swingRequireProfitForExit!,
    makerRefreshMs: makerRefreshMs!,
    makerEntryDepthLevel: makerEntryDepthLevel!,
    makerBidOffset: makerBidOffset!,
    makerAskOffset: makerAskOffset!,
    makerRepriceTicks: makerRepriceTicks!,
    makerMinDwellMs: makerMinDwellMs!,
    makerDepthLevels: makerDepthLevels!,
    offsetSkipRatio: offsetSkipRatio!,
    offsetForcedExitRatio: offsetForcedExitRatio!,
    liquiditySkipRatio: liquiditySkipRatio!,
    liquidityCloseTickOffset: liquidityCloseTickOffset!,
    liquidityRecentFillMs: liquidityRecentFillMs!,
  };
}

export function loadConfig(source: EnvSource = process.env): AppConfig {
  return parseEnv(source);
}
