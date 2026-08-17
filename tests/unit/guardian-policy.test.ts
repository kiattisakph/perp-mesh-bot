import { describe, expect, it } from "vitest";
import { isEntryIntent } from "../../src/domain/intent";
import type { FuturesPosition } from "../../src/domain/account";
import type { StrategySnapshot } from "../../src/domain/strategy";
import {
  ExecutionService,
  IntentPipeline,
} from "../../src/application";
import { RateLimitMachine } from "../../src/risk/rate-limit";
import {
  evaluateGuardian,
  profitLockSteps,
  profitLockStopPrice,
  trailingActivationPrice,
  type GuardianConfig,
} from "../../src/strategies/guardian";
import { FakeVenue } from "../helpers/fake-venue";
import {
  btcPrecision,
  foreignOrder,
  longPosition,
  testAccount,
  testOrder,
  testOwnership,
  testRiskContext,
} from "../helpers/trading-fixtures";

const ownership = testOwnership("guardian", "a1");

const guardianConfig: GuardianConfig = {
  lossLimitUsdt: 2,
  trailingActivationProfitUsdt: 3,
  trailingCallbackRate: 0.2,
  profitLockTriggerUsdt: 2,
  profitLockStepUsdt: 1,
};

function shortPosition(
  quantity = -0.001,
  entryPrice = 100_000,
): FuturesPosition {
  return {
    ...longPosition(Math.abs(quantity), entryPrice),
    quantity,
  };
}

function snapshot(input: {
  position?: FuturesPosition | null;
  openOrders?: StrategySnapshot["openOrders"];
  markPrice?: number;
  lifecycle?: StrategySnapshot["lifecycle"];
} = {}): StrategySnapshot {
  const position = input.position === undefined ? longPosition() : input.position;
  const mark =
    input.markPrice ??
    (position === null ? 100_000 : position.markPrice);
  return {
    strategyId: "guardian",
    instanceId: "a1",
    symbol: "BTCUSDT",
    lifecycle: input.lifecycle ?? "READY",
    rateLimitState: "NORMAL",
    account: testAccount(position),
    position,
    openOrders: input.openOrders ?? [],
    ticker: {
      symbol: "BTCUSDT",
      lastPrice: mark,
      markPrice: mark,
      eventTime: 1,
    },
    markPrice: mark,
    precision: btcPrecision,
    now: 1_000,
  };
}

function decide(
  input: Parameters<typeof snapshot>[0] = {},
): ReturnType<typeof evaluateGuardian> {
  return evaluateGuardian({
    snapshot: snapshot(input),
    config: guardianConfig,
    ownership,
  });
}

describe("Guardian formulas", () => {
  it("computes trailing activation from USD profit / quantity", () => {
    expect(
      trailingActivationPrice({
        entryPrice: 100_000,
        quantity: 0.001,
        trailingProfitUsd: 3,
      }),
    ).toBe(103_000);
    expect(
      trailingActivationPrice({
        entryPrice: 100_000,
        quantity: -0.001,
        trailingProfitUsd: 3,
      }),
    ).toBe(97_000);
  });

  it("counts profit-lock steps only after the trigger", () => {
    expect(
      profitLockSteps({ profit: 1.9, triggerUsd: 2, offsetUsd: 1 }),
    ).toBe(0);
    expect(
      profitLockSteps({ profit: 2, triggerUsd: 2, offsetUsd: 1 }),
    ).toBe(1);
    expect(
      profitLockSteps({ profit: 3.9, triggerUsd: 2, offsetUsd: 1 }),
    ).toBe(2);
  });

  it("moves the USD stop by steps * offsetUsd in the risk-reducing direction", () => {
    expect(
      profitLockStopPrice({
        entryPrice: 100_000,
        quantity: 0.001,
        lossUsd: 2,
        profit: 0,
        triggerUsd: 2,
        offsetUsd: 1,
      }),
    ).toBe(98_000);
    expect(
      profitLockStopPrice({
        entryPrice: 100_000,
        quantity: 0.001,
        lossUsd: 2,
        profit: 2,
        triggerUsd: 2,
        offsetUsd: 1,
      }),
    ).toBe(99_000);
    expect(
      profitLockStopPrice({
        entryPrice: 100_000,
        quantity: -0.001,
        lossUsd: 2,
        profit: 2,
        triggerUsd: 2,
        offsetUsd: 1,
      }),
    ).toBe(101_000);
  });
});

describe("Guardian policy", () => {
  it("places a reduce-only mark stop and trailing stop when a position has none", () => {
    const { intents, state } = decide({ lifecycle: "READY" });
    expect(state.phase).toBe("PENDING_PROTECTION");
    expect(intents).toEqual([
      {
        type: "PLACE_STOP",
        strategyId: "guardian",
        symbol: "BTCUSDT",
        side: "SELL",
        stopPrice: 98_000,
        quantity: 0.001,
        reduceOnly: true,
      },
      {
        type: "PLACE_TRAILING_STOP",
        strategyId: "guardian",
        symbol: "BTCUSDT",
        side: "SELL",
        activationPrice: 103_000,
        callbackRate: 0.2,
        quantity: 0.001,
        reduceOnly: true,
      },
    ]);
    expect(intents.every((intent) => !isEntryIntent(intent))).toBe(true);
  });

  it("moves the stop on profit-lock steps and never widens risk", () => {
    const liveStop = testOrder(ownership, {
      purpose: "stop",
      sequence: 1,
      side: "SELL",
      type: "STOP_MARKET",
      reduceOnly: true,
      stopPrice: 98_000,
      quantity: 0.001,
    });
    const liveTrail = testOrder(ownership, {
      purpose: "trail",
      sequence: 2,
      side: "SELL",
      type: "TRAILING_STOP_MARKET",
      reduceOnly: true,
      activationPrice: 103_000,
      quantity: 0.001,
    });
    const { intents, state } = decide({
      markPrice: 102_000,
      openOrders: [liveStop, liveTrail],
    });
    expect(state.phase).toBe("MOVE_STOP");
    expect(intents).toEqual([
      {
        type: "CANCEL",
        strategyId: "guardian",
        orderIds: [liveStop.clientOrderId],
      },
      {
        type: "PLACE_STOP",
        strategyId: "guardian",
        symbol: "BTCUSDT",
        side: "SELL",
        stopPrice: 99_000,
        quantity: 0.001,
        reduceOnly: true,
      },
    ]);
  });

  it("never emits an intent that would open or increase a position", () => {
    const cases = [
      decide({}),
      decide({ position: shortPosition(), markPrice: 99_000 }),
      decide({ position: null }),
      decide({
        position: longPosition(),
        markPrice: 110_000,
        openOrders: [
          testOrder(ownership, {
            purpose: "stop",
            sequence: 1,
            side: "SELL",
            type: "STOP_MARKET",
            reduceOnly: true,
            stopPrice: 98_000,
            quantity: 0.001,
          }),
        ],
      }),
    ];
    for (const result of cases) {
      expect(result.intents.some(isEntryIntent)).toBe(false);
      expect(
        result.intents.some(
          (intent) =>
            intent.type === "PLACE_MARKET" || intent.type === "PLACE_LIMIT",
        ),
      ).toBe(false);
      for (const intent of result.intents) {
        if (intent.type === "PLACE_STOP" || intent.type === "PLACE_TRAILING_STOP") {
          expect(intent.reduceOnly).toBe(true);
        }
      }
    }
  });

  it("cancels only Guardian-owned protective orders when flat", () => {
    const ownedStop = testOrder(ownership, {
      purpose: "stop",
      sequence: 1,
      side: "SELL",
      type: "STOP_MARKET",
      reduceOnly: true,
      stopPrice: 98_000,
      quantity: 0.001,
    });
    const foreign = foreignOrder();
    const otherStrategy = testOrder(testOwnership("trend", "a1"), {
      purpose: "stop",
      sequence: 9,
      side: "SELL",
      type: "STOP_MARKET",
      reduceOnly: true,
      stopPrice: 97_000,
      quantity: 0.001,
    });
    const { intents, state } = decide({
      position: null,
      openOrders: [ownedStop, foreign, otherStrategy],
    });
    expect(state.phase).toBe("CLEANUP");
    expect(intents).toEqual([
      {
        type: "CANCEL",
        strategyId: "guardian",
        orderIds: [ownedStop.clientOrderId],
      },
    ]);
  });

  it("resumes protection immediately on restart while in position", () => {
    const { intents, state } = decide({ lifecycle: "RECONCILING" });
    expect(state.phase).toBe("PENDING_PROTECTION");
    expect(intents.some((intent) => intent.type === "PLACE_STOP")).toBe(true);
    expect(intents.some((intent) => intent.type === "PLACE_TRAILING_STOP")).toBe(
      true,
    );
  });

  it("does not duplicate matching owned stops after restart", () => {
    const stop = testOrder(ownership, {
      purpose: "stop",
      sequence: 1,
      side: "SELL",
      type: "STOP_MARKET",
      reduceOnly: true,
      stopPrice: 98_000,
      quantity: 0.001,
    });
    const trail = testOrder(ownership, {
      purpose: "trail",
      sequence: 2,
      side: "SELL",
      type: "TRAILING_STOP_MARKET",
      reduceOnly: true,
      activationPrice: 103_000,
      quantity: 0.001,
    });
    const { intents, state } = decide({
      lifecycle: "RECONCILING",
      openOrders: [stop, trail],
    });
    expect(state.phase).toBe("PROTECTING");
    expect(intents).toEqual([]);
  });

  it("protects a short with a buy reduce-only stop", () => {
    const { intents } = decide({
      position: shortPosition(),
      markPrice: 100_000,
    });
    expect(intents[0]).toMatchObject({
      type: "PLACE_STOP",
      side: "BUY",
      stopPrice: 102_000,
      reduceOnly: true,
    });
  });
});

describe("Guardian execution rollback and restart", () => {
  it("restores the previous stop when a replacement place fails", async () => {
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(longPosition()),
    });
    const execution = new ExecutionService(venue, ownership);
    const first = await execution.execute(
      [
        {
          type: "PLACE_STOP",
          strategyId: "guardian",
          symbol: "BTCUSDT",
          side: "SELL",
          stopPrice: 98_000,
          quantity: 0.001,
          reduceOnly: true,
        },
      ],
      { symbol: "BTCUSDT", ownership, openOrders: [] },
    );
    const liveStop = first.placed[0]!;
    venue.nextPlaceError = new Error("replacement rejected");
    await expect(
      execution.execute(
        [
          {
            type: "CANCEL",
            strategyId: "guardian",
            orderIds: [liveStop.clientOrderId],
          },
          {
            type: "PLACE_STOP",
            strategyId: "guardian",
            symbol: "BTCUSDT",
            side: "SELL",
            stopPrice: 99_000,
            quantity: 0.001,
            reduceOnly: true,
          },
        ],
        { symbol: "BTCUSDT", ownership, openOrders: [liveStop] },
      ),
    ).rejects.toThrow(/replacement rejected/);
    const live = [...venue.orders.values()].filter(
      (order) => order.status === "NEW" || order.status === "PARTIALLY_FILLED",
    );
    expect(live.some((order) => order.stopPrice === 98_000)).toBe(true);
    expect(live.every((order) => order.reduceOnly)).toBe(true);
    expect(venue.cancelAllOrdersCalls).toBe(0);
  });

  it("covers an existing position after a simulated restart without duplicating", async () => {
    const position = longPosition();
    const venue = new FakeVenue({
      precision: btcPrecision,
      account: testAccount(position),
    });
    const first = new ExecutionService(venue, ownership);
    const pipeline = new IntentPipeline(
      first,
      new RateLimitMachine({
        cleanWindowMs: 1_000,
        pausedCooldownMs: 1_000,
        repeated429WhileDegraded: 1,
      }),
    );
    const firstTick = decide({});
    const placed = await pipeline.run(
      firstTick.intents,
      testRiskContext(ownership, {
        position,
        account: testAccount(position),
        openOrders: [],
        markPrice: 100_000,
      }),
    );
    expect(placed.execution?.placed.some((order) => order.type === "STOP_MARKET")).toBe(
      true,
    );
    const open = await venue.fetchOpenOrders("BTCUSDT");
    const restarted = ExecutionService.fromOpenOrders(venue, ownership, open);
    const restartPipeline = new IntentPipeline(
      restarted,
      new RateLimitMachine({
        cleanWindowMs: 1_000,
        pausedCooldownMs: 1_000,
        repeated429WhileDegraded: 1,
      }),
    );
    const secondTick = decide({
      lifecycle: "RECONCILING",
      openOrders: open,
      position,
    });
    expect(secondTick.state.phase).toBe("PROTECTING");
    expect(secondTick.intents).toEqual([]);
    const after = await restartPipeline.run(
      secondTick.intents,
      testRiskContext(ownership, {
        position,
        account: testAccount(position),
        openOrders: open,
        markPrice: 100_000,
        lifecycleReconciling: true,
      }),
    );
    expect(after.execution).toBeUndefined();
    expect(venue.placeCalls.filter((call) => call.intent.type === "PLACE_STOP")).toHaveLength(
      1,
    );
  });
});
