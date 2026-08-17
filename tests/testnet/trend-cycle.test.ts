import { describe, expect, it } from "vitest";
import { isEntryIntent } from "../../src/domain/intent";
import { isFlat } from "../../src/domain/position";
import {
  ExecutionService,
  createOrderOwnership,
  positionCoveredByOwnedStops,
} from "../../src/application";
import { BinanceUsdmAdapter } from "../../src/infrastructure/binance-usdm/binance-adapter";
import {
  evaluateTrend,
  type TrendConfig,
} from "../../src/strategies/trend";
import { sma } from "../../src/indicators/sma";

const apiKey = process.env.BINANCE_API_KEY ?? "";
const apiSecret = process.env.BINANCE_API_SECRET ?? "";
const hasKeys = apiKey !== "" && apiSecret !== "";

const trendConfig: TrendConfig = {
  tradeQuantity: Number(process.env.TRADE_QUANTITY ?? "0.001"),
  smaPeriod: Number(process.env.TREND_SMA_PERIOD ?? "30"),
  bollingerLength: Number(process.env.TREND_BOLLINGER_LENGTH ?? "20"),
  bollingerMultiplier: Number(process.env.TREND_BOLLINGER_MULTIPLIER ?? "2"),
  minBandwidth: Number(process.env.TREND_MIN_BANDWIDTH ?? "0.001"),
  entryCooldownMs: Number(process.env.TREND_ENTRY_COOLDOWN_MS ?? "60000"),
  lossLimitUsdt: Number(process.env.LOSS_LIMIT_USDT ?? "2"),
  trailingActivationProfitUsdt: Number(
    process.env.TRAILING_ACTIVATION_PROFIT_USDT ?? "3",
  ),
  trailingCallbackRate: Number(process.env.TRAILING_CALLBACK_RATE ?? "0.2"),
  profitLockTriggerUsdt: Number(process.env.PROFIT_LOCK_TRIGGER_USDT ?? "2"),
  profitLockStepUsdt: Number(process.env.PROFIT_LOCK_STEP_USDT ?? "1"),
};

describe.skipIf(!hasKeys)("testnet Trend open / protect / close cycle", () => {
  it("opens one controlled position, protects it, and does not double-enter", async () => {
    const symbol = (process.env.BINANCE_SYMBOL ?? "BTCUSDT").toUpperCase();
    const interval = process.env.TREND_KLINE_INTERVAL ?? "1m";
    const ownership = createOrderOwnership({
      strategyId: "trend",
      instanceId: "t6",
    });
    const adapter = new BinanceUsdmAdapter({
      apiKey,
      apiSecret,
      testnet: true,
      reconnectMaxMs: 60_000,
      strategyId: "trend",
    });
    const precision = await adapter.loadPrecision(symbol);
    const markPrice = await adapter.fetchMarkPrice(symbol);
    const now = Date.now();
    const needed = Math.max(trendConfig.smaPeriod, trendConfig.bollingerLength);
    await adapter.fetchKlines(symbol, interval, needed);
    const candles = Array.from({ length: needed }, (_, index) => {
      const wave = index % 3 === 0 ? 0.98 : index % 3 === 1 ? 1 : 1.02;
      const close = markPrice * wave;
      return {
        symbol,
        interval,
        openTime: now - (needed - index) * 60_000,
        closeTime: now - (needed - index) * 60_000 + 59_999,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
        closed: true,
      };
    });
    const account = await adapter.fetchAccount(symbol);
    const existing =
      account.positions.find(
        (row) => row.symbol === symbol && !isFlat(row.quantity),
      ) ?? null;
    const openOrders = await adapter.fetchOpenOrders(symbol);
    const baseSnapshot = {
      strategyId: "trend",
      instanceId: "t6",
      symbol,
      lifecycle: "READY" as const,
      rateLimitState: "NORMAL" as const,
      account,
      position: existing,
      openOrders,
      ticker: {
        symbol,
        lastPrice: markPrice,
        markPrice,
        eventTime: now,
      },
      markPrice,
      candles,
      precision,
      now,
    };

    if (existing !== null) {
      const restart = evaluateTrend({
        snapshot: { ...baseSnapshot, lifecycle: "RECONCILING" },
        config: trendConfig,
        ownership,
      });
      expect(restart.intents.some(isEntryIntent)).toBe(false);
      const execution = ExecutionService.fromOpenOrders(
        adapter,
        ownership,
        openOrders,
      );
      if (restart.intents.length > 0) {
        await execution.execute(restart.intents, {
          symbol,
          ownership,
          openOrders,
        });
      }
      const after = await adapter.fetchOpenOrders(symbol);
      expect(
        positionCoveredByOwnedStops(existing, after, ownership),
      ).toBe(true);
      return;
    }

    const closes = candles.filter((candle) => candle.closed).map((c) => c.close);
    const smaValue = sma(closes, trendConfig.smaPeriod);
    const long = evaluateTrend({
      snapshot: {
        ...baseSnapshot,
        ticker: {
          symbol,
          lastPrice: smaValue + precision.tickSize,
          markPrice,
          eventTime: now,
        },
      },
      config: trendConfig,
      ownership,
      state: { phase: "FLAT", previousPrice: smaValue - precision.tickSize },
    });
    const entry = long.intents.find(isEntryIntent);
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }
    const execution = ExecutionService.fromOpenOrders(
      adapter,
      ownership,
      openOrders,
    );
    await execution.execute([entry], { symbol, ownership, openOrders });
    const afterOpen = await adapter.fetchAccount(symbol);
    const position =
      afterOpen.positions.find(
        (row) => row.symbol === symbol && !isFlat(row.quantity),
      ) ?? null;
    expect(position).not.toBeNull();
    if (position === null) {
      return;
    }

    const afterOpenOrders = await adapter.fetchOpenOrders(symbol);
    const protect = evaluateTrend({
      snapshot: {
        ...baseSnapshot,
        account: afterOpen,
        position,
        openOrders: afterOpenOrders,
        now: Date.now(),
      },
      config: trendConfig,
      ownership,
      state: long.state,
    });
    expect(protect.intents.some(isEntryIntent)).toBe(false);
    if (protect.intents.length > 0) {
      await execution.execute(protect.intents, {
        symbol,
        ownership,
        openOrders: afterOpenOrders,
      });
    }
    const protectedOrders = await adapter.fetchOpenOrders(symbol);
    expect(
      positionCoveredByOwnedStops(position, protectedOrders, ownership),
    ).toBe(true);

    const restart = evaluateTrend({
      snapshot: {
        ...baseSnapshot,
        lifecycle: "RECONCILING",
        account: afterOpen,
        position,
        openOrders: protectedOrders,
        ticker: {
          symbol,
          lastPrice: smaValue + precision.tickSize,
          markPrice,
          eventTime: Date.now(),
        },
        now: Date.now(),
      },
      config: trendConfig,
      ownership,
      state: protect.state,
    });
    expect(restart.intents.some(isEntryIntent)).toBe(false);

    const adverse =
      position.quantity > 0
        ? position.entryPrice - (trendConfig.lossLimitUsdt + 1) / position.quantity
        : position.entryPrice +
          (trendConfig.lossLimitUsdt + 1) / Math.abs(position.quantity);
    const closing = evaluateTrend({
      snapshot: {
        ...baseSnapshot,
        account: afterOpen,
        position,
        openOrders: protectedOrders,
        markPrice: adverse,
        ticker: {
          symbol,
          lastPrice: adverse,
          markPrice: adverse,
          eventTime: Date.now(),
        },
        now: Date.now(),
      },
      config: trendConfig,
      ownership,
      state: protect.state,
    });
    const close = closing.intents.find(
      (intent) => intent.type === "PLACE_MARKET" && intent.reduceOnly === true,
    );
    expect(close).toBeDefined();
    if (close !== undefined) {
      await execution.execute([close], {
        symbol,
        ownership,
        openOrders: protectedOrders,
      });
    }
    const afterClose = await adapter.fetchAccount(symbol);
    const leftover =
      afterClose.positions.find(
        (row) => row.symbol === symbol && !isFlat(row.quantity),
      ) ?? null;
    expect(leftover).toBeNull();

    const cooldown = evaluateTrend({
      snapshot: {
        ...baseSnapshot,
        account: afterClose,
        position: null,
        openOrders: await adapter.fetchOpenOrders(symbol),
        ticker: {
          symbol,
          lastPrice: smaValue + precision.tickSize,
          markPrice,
          eventTime: Date.now(),
        },
        now: Date.now(),
      },
      config: trendConfig,
      ownership,
      state: { ...closing.state, phase: "IN_POSITION" },
    });
    expect(cooldown.intents.some(isEntryIntent)).toBe(false);
    expect(cooldown.state.lastStopAt).toBeDefined();
  }, 60_000);
});
