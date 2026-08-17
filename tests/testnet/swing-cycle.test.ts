import { describe, expect, it } from "vitest";
import { isEntryIntent } from "../../src/domain/intent";
import { isFlat } from "../../src/domain/position";
import {
  ExecutionService,
  createOrderOwnership,
  positionCoveredByOwnedStops,
} from "../../src/application";
import { BinanceUsdmAdapter } from "../../src/infrastructure/binance-usdm/binance-adapter";
import { rsiFromClosedCloses } from "../../src/indicators/rsi";
import {
  evaluateSwing,
  type SwingConfig,
} from "../../src/strategies/swing";

const apiKey = process.env.BINANCE_API_KEY ?? "";
const apiSecret = process.env.BINANCE_API_SECRET ?? "";
const hasKeys = apiKey !== "" && apiSecret !== "";

const swingConfig: SwingConfig = {
  tradeQuantity: Number(process.env.TRADE_QUANTITY ?? "0.001"),
  direction: "both",
  rsiPeriod: Number(process.env.SWING_RSI_PERIOD ?? "14"),
  rsiHigh: Number(process.env.SWING_RSI_HIGH ?? "70"),
  rsiLow: Number(process.env.SWING_RSI_LOW ?? "30"),
  stopLossFraction: Number(process.env.SWING_STOP_LOSS_FRACTION ?? "0.05"),
  requireProfitForExit: process.env.SWING_REQUIRE_PROFIT_FOR_EXIT !== "false",
};

function closesEndingAtRsi(target: number, period: number): number[] {
  const seed: number[] = [];
  for (let i = 0; i < period + 5; i++) {
    seed.push(100);
  }
  for (let i = 0; i < 20; i++) {
    seed.push(100 - i);
  }
  for (let i = 0; i < 10; i++) {
    seed.push(80 + i);
  }
  let lo = 1;
  let hi = 200;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const value = rsiFromClosedCloses([...seed, mid], period);
    if (value === null) {
      throw new Error("RSI not stable");
    }
    if (value < target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return [...seed, (lo + hi) / 2];
}

describe.skipIf(!hasKeys)("testnet Swing arm / open / exit and stop cycle", () => {
  it("opens from an RSI cross, protects, restores arms on restart, and stop-closes", async () => {
    const symbol = (process.env.BINANCE_SYMBOL ?? "BTCUSDT").toUpperCase();
    const signalSymbol = (
      process.env.SWING_SIGNAL_SYMBOL ?? symbol
    ).toUpperCase();
    const interval = process.env.SWING_SIGNAL_INTERVAL ?? "4h";
    const ownership = createOrderOwnership({
      strategyId: "swing",
      instanceId: "t7",
    });
    const adapter = new BinanceUsdmAdapter({
      apiKey,
      apiSecret,
      testnet: true,
      reconnectMaxMs: 60_000,
      strategyId: "swing",
    });
    const precision = await adapter.loadPrecision(symbol);
    const markPrice = await adapter.fetchMarkPrice(symbol);
    const now = Date.now();
    await adapter.fetchKlines(
      signalSymbol,
      interval,
      swingConfig.rsiPeriod + 1,
    );
    const closes = closesEndingAtRsi(69, swingConfig.rsiPeriod);
    const candles = closes.map((close, index) => ({
      symbol: signalSymbol,
      interval,
      openTime: now - (closes.length - index) * 14_400_000,
      closeTime: now - (closes.length - index) * 14_400_000 + 14_399_999,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
      closed: true,
    }));
    const account = await adapter.fetchAccount(symbol);
    const existing =
      account.positions.find(
        (row) => row.symbol === symbol && !isFlat(row.quantity),
      ) ?? null;
    const openOrders = await adapter.fetchOpenOrders(symbol);
    const baseSnapshot = {
      strategyId: "swing",
      instanceId: "t7",
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
      const restart = evaluateSwing({
        snapshot: { ...baseSnapshot, lifecycle: "RECONCILING" },
        config: swingConfig,
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

    const long = evaluateSwing({
      snapshot: baseSnapshot,
      config: swingConfig,
      ownership,
      state: {
        previousRsi: 71,
        armedShortEntry: true,
        armedShortExit: false,
        armedLongEntry: false,
        armedLongExit: false,
      },
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
    const protect = evaluateSwing({
      snapshot: {
        ...baseSnapshot,
        account: afterOpen,
        position,
        openOrders: afterOpenOrders,
        now: Date.now(),
      },
      config: swingConfig,
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

    const restartArmed = evaluateSwing({
      snapshot: {
        ...baseSnapshot,
        lifecycle: "RECONCILING",
        account: afterOpen,
        position,
        openOrders: protectedOrders,
        now: Date.now(),
      },
      config: swingConfig,
      ownership,
      state: protect.state,
    });
    expect(restartArmed.intents.some(isEntryIntent)).toBe(false);

    const adverse =
      position.quantity > 0
        ? position.entryPrice * (1 - swingConfig.stopLossFraction) -
          precision.tickSize
        : position.entryPrice * (1 + swingConfig.stopLossFraction) +
          precision.tickSize;
    const closing = evaluateSwing({
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
      config: swingConfig,
      ownership,
      state: protect.state,
    });
    const close = closing.intents.find(
      (intent) => intent.type === "PLACE_MARKET" && intent.reduceOnly === true,
    );
    expect(close).toBeDefined();
    expect(close).toMatchObject({ reason: "swing_stop" });
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
  }, 60_000);
});
