import { describe, expect, it } from "vitest";
import type { OrderIntent } from "../../src/domain/intent";
import { filterIntents } from "../../src/application/risk-service";
import {
  defaultLimits,
  longPosition,
  testAccount,
  testOrder,
  testOwnership,
  testRiskContext,
} from "../helpers/trading-fixtures";

const ownership = testOwnership();

const entry: OrderIntent = {
  type: "PLACE_MARKET",
  strategyId: "trend",
  symbol: "BTCUSDT",
  side: "BUY",
  quantity: 0.001,
  reduceOnly: false,
  reason: "test_entry",
};

const stop: OrderIntent = {
  type: "PLACE_STOP",
  strategyId: "trend",
  symbol: "BTCUSDT",
  side: "SELL",
  stopPrice: 99_000,
  quantity: 0.001,
  reduceOnly: true,
};

describe("risk service", () => {
  it("allows a sized entry within position and notional caps", () => {
    const decision = filterIntents([entry], testRiskContext(ownership));
    expect(decision.rejected).toEqual([]);
    expect(decision.allowed).toEqual([entry]);
  });

  it("rejects an entry that would exceed MAX_POSITION_QUANTITY", () => {
    const decision = filterIntents(
      [{ ...entry, quantity: 0.003 }],
      testRiskContext(ownership),
    );
    expect(decision.allowed).toEqual([]);
    expect(decision.rejected[0]?.reason).toBe("max_position");
  });

  it("rejects an entry that would exceed MAX_NOTIONAL_USDT", () => {
    const decision = filterIntents(
      [entry],
      testRiskContext(ownership, {
        limits: { ...defaultLimits, maxNotionalUsdt: 50 },
      }),
    );
    expect(decision.rejected[0]?.reason).toBe("max_notional");
  });

  it("rejects a close that is not reduce-only", () => {
    const decision = filterIntents(
      [
        {
          type: "PLACE_MARKET",
          strategyId: "trend",
          symbol: "BTCUSDT",
          side: "SELL",
          quantity: 0.001,
          reduceOnly: false,
          reason: "bad_close",
        },
      ],
      testRiskContext(ownership, {
        position: longPosition(),
        account: testAccount(longPosition()),
      }),
    );
    expect(decision.rejected[0]?.reason).toBe("exit_not_reduce_only");
  });

  it("rejects a close larger than the absolute position", () => {
    const decision = filterIntents(
      [
        {
          type: "PLACE_MARKET",
          strategyId: "trend",
          symbol: "BTCUSDT",
          side: "SELL",
          quantity: 0.002,
          reduceOnly: true,
          reason: "oversized_close",
        },
      ],
      testRiskContext(ownership, {
        position: longPosition(0.001),
        account: testAccount(longPosition(0.001)),
      }),
    );
    expect(decision.rejected[0]?.reason).toBe("close_exceeds_position");
  });

  it("blocks a reduce-only market close that fails mark slippage", () => {
    const decision = filterIntents(
      [
        {
          type: "PLACE_MARKET",
          strategyId: "trend",
          symbol: "BTCUSDT",
          side: "SELL",
          quantity: 0.001,
          reduceOnly: true,
          reason: "flatten",
        },
      ],
      testRiskContext(ownership, {
        position: longPosition(),
        account: testAccount(longPosition()),
        markPrice: 100_000,
        closeCandidatePrice: 99_000,
      }),
    );
    expect(decision.rejected[0]?.reason).toBe("slippage");
  });

  it("rejects a duplicate in-flight or live purpose+side", () => {
    const live = testOrder(ownership, {
      purpose: "entry",
      sequence: 1,
      side: "BUY",
      type: "MARKET",
      reduceOnly: false,
    });
    const decision = filterIntents(
      [entry],
      testRiskContext(ownership, { openOrders: [live] }),
    );
    expect(decision.rejected[0]?.reason).toBe("duplicate");
  });

  it("rejects a second identical place in the same batch", () => {
    const decision = filterIntents(
      [entry, { ...entry, reason: "again" }],
      testRiskContext(ownership),
    );
    expect(decision.allowed).toHaveLength(1);
    expect(decision.rejected[0]?.reason).toBe("duplicate");
  });

  it("stops entry when feeds are stale but keeps protection", () => {
    const decision = filterIntents(
      [entry, stop],
      testRiskContext(ownership, {
        position: longPosition(),
        account: testAccount(longPosition()),
        freshness: {
          depthStale: true,
          userStreamStale: false,
          accountStale: false,
          marketStale: false,
        },
      }),
    );
    expect(decision.rejected.some((row) => row.reason === "stale_feed")).toBe(
      true,
    );
    expect(decision.allowed).toEqual([stop]);
  });

  it("stops entry in DEGRADED and PAUSED but still allows a stop", () => {
    for (const rateLimitState of ["DEGRADED", "PAUSED"] as const) {
      const decision = filterIntents(
        [entry, stop],
        testRiskContext(ownership, {
          position: longPosition(),
          account: testAccount(longPosition()),
          rateLimitState,
        }),
      );
      expect(decision.rejected[0]?.reason).toBe("rate_limit");
      expect(decision.allowed).toEqual([stop]);
    }
  });

  it("blocks entry while reconciling and while the kill switch is engaged", () => {
    expect(
      filterIntents(
        [entry],
        testRiskContext(ownership, { lifecycleReconciling: true }),
      ).rejected[0]?.reason,
    ).toBe("reconciling");
    expect(
      filterIntents(
        [entry],
        testRiskContext(ownership, { killSwitchEngaged: true }),
      ).rejected[0]?.reason,
    ).toBe("kill_switch");
  });

  it("never cancels an unowned order id", () => {
    const decision = filterIntents(
      [{ type: "CANCEL", strategyId: "trend", orderIds: ["manual-keep-me"] }],
      testRiskContext(ownership),
    );
    expect(decision.allowed).toEqual([]);
    expect(decision.rejected[0]?.reason).toBe("not_owned_cancel");
  });

  it("strips unowned ids from a mixed CANCEL and keeps owned ids", () => {
    const owned = testOrder(ownership, {
      purpose: "bid",
      sequence: 1,
      side: "BUY",
      reduceOnly: false,
      price: 100,
    });
    const decision = filterIntents(
      [
        {
          type: "CANCEL",
          strategyId: "trend",
          orderIds: ["manual-keep-me", owned.clientOrderId],
        },
      ],
      testRiskContext(ownership, { openOrders: [owned] }),
    );
    expect(decision.allowed).toEqual([
      {
        type: "CANCEL",
        strategyId: "trend",
        orderIds: [owned.clientOrderId],
      },
    ]);
  });

  it("rejects session-loss entries and unknown precision places", () => {
    const losing = testAccount(longPosition());
    losing.walletBalance = 980;
    losing.positions[0]!.unrealizedPnl = -12;
    expect(
      filterIntents(
        [entry],
        testRiskContext(ownership, {
          account: losing,
          sessionStartEquity: 1000,
        }),
      ).rejected[0]?.reason,
    ).toBe("session_loss");
    expect(
      filterIntents(
        [entry],
        testRiskContext(ownership, { precision: undefined }),
      ).rejected[0]?.reason,
    ).toBe("unknown_precision");
  });
});
