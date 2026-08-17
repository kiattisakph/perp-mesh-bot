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
  evaluateGuardian,
  type GuardianConfig,
} from "../../src/strategies/guardian";

const apiKey = process.env.BINANCE_API_KEY ?? "";
const apiSecret = process.env.BINANCE_API_SECRET ?? "";
const hasKeys = apiKey !== "" && apiSecret !== "";

const guardianConfig: GuardianConfig = {
  lossLimitUsdt: Number(process.env.LOSS_LIMIT_USDT ?? "2"),
  trailingActivationProfitUsdt: Number(
    process.env.TRAILING_ACTIVATION_PROFIT_USDT ?? "3",
  ),
  trailingCallbackRate: Number(process.env.TRAILING_CALLBACK_RATE ?? "0.2"),
  profitLockTriggerUsdt: Number(process.env.PROFIT_LOCK_TRIGGER_USDT ?? "2"),
  profitLockStepUsdt: Number(process.env.PROFIT_LOCK_STEP_USDT ?? "1"),
};

describe.skipIf(!hasKeys)("testnet Guardian existing-position protection", () => {
  it("protects an existing position and does not duplicate after restart", async () => {
    const symbol = (process.env.BINANCE_SYMBOL ?? "BTCUSDT").toUpperCase();
    const ownership = createOrderOwnership({
      strategyId: "guardian",
      instanceId: "t5",
    });
    const adapter = new BinanceUsdmAdapter({
      apiKey,
      apiSecret,
      testnet: true,
      reconnectMaxMs: 60_000,
      strategyId: "guardian",
    });
    const precision = await adapter.loadPrecision(symbol);
    const markPrice = await adapter.fetchMarkPrice(symbol);
    const account = await adapter.fetchAccount(symbol);
    const position =
      account.positions.find(
        (row) => row.symbol === symbol && !isFlat(row.quantity),
      ) ?? null;
    if (position === null) {
      return;
    }
    const openOrders = await adapter.fetchOpenOrders(symbol);
    const snapshot = {
      strategyId: "guardian",
      instanceId: "t5",
      symbol,
      lifecycle: "READY" as const,
      rateLimitState: "NORMAL" as const,
      account,
      position,
      openOrders,
      ticker: {
        symbol,
        lastPrice: markPrice,
        markPrice,
        eventTime: Date.now(),
      },
      markPrice,
      precision,
      now: Date.now(),
    };
    const first = evaluateGuardian({ snapshot, config: guardianConfig, ownership });
    expect(first.intents.some(isEntryIntent)).toBe(false);
    const execution = ExecutionService.fromOpenOrders(adapter, ownership, openOrders);
    if (first.intents.length > 0) {
      await execution.execute(first.intents, {
        symbol,
        ownership,
        openOrders,
      });
    }
    const afterProtect = await adapter.fetchOpenOrders(symbol);
    expect(
      positionCoveredByOwnedStops(position, afterProtect, ownership),
    ).toBe(true);

    const restart = evaluateGuardian({
      snapshot: {
        ...snapshot,
        lifecycle: "RECONCILING",
        openOrders: afterProtect,
      },
      config: guardianConfig,
      ownership,
    });
    expect(restart.intents.some(isEntryIntent)).toBe(false);
    const restarted = ExecutionService.fromOpenOrders(
      adapter,
      ownership,
      afterProtect,
    );
    const before = afterProtect.filter(
      (order) =>
        order.type === "STOP_MARKET" &&
        order.clientOrderId.startsWith(ownership.prefix),
    ).length;
    if (restart.intents.length > 0) {
      await restarted.execute(restart.intents, {
        symbol,
        ownership,
        openOrders: afterProtect,
      });
    }
    const afterRestart = await adapter.fetchOpenOrders(symbol);
    const afterStops = afterRestart.filter(
      (order) =>
        order.type === "STOP_MARKET" &&
        order.clientOrderId.startsWith(ownership.prefix),
    );
    expect(afterStops.length).toBeGreaterThanOrEqual(1);
    expect(afterStops.length).toBeLessThanOrEqual(Math.max(1, before));
    expect(
      positionCoveredByOwnedStops(position, afterRestart, ownership),
    ).toBe(true);
  }, 30_000);
});
