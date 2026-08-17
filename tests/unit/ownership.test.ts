import { describe, expect, it } from "vitest";
import {
  CLIENT_ORDER_APP_PREFIX,
  CLIENT_ORDER_ID_MAX_LEN,
  buildClientOrderId,
  createOrderOwnership,
  isBotOwned,
  nextClientOrderSequence,
  parseOwnedClientOrderId,
  purposeOf,
} from "../../src/application/ownership";

describe("order ownership", () => {
  it("builds clientOrderId with a verifiable instance prefix under 36 chars", () => {
    const ownership = createOrderOwnership({
      strategyId: "trend",
      instanceId: "a1",
    });
    const id = buildClientOrderId({
      ownership,
      purpose: "stop",
      sequence: 42,
    });
    expect(ownership.prefix).toBe(`${CLIENT_ORDER_APP_PREFIX}-trend-a1-`);
    expect(id).toBe(`${CLIENT_ORDER_APP_PREFIX}-trend-a1-stop-000042`);
    expect(id.length).toBeLessThanOrEqual(CLIENT_ORDER_ID_MAX_LEN);
    expect(isBotOwned(id, ownership)).toBe(true);
  });

  it("does not treat another strategy or instance as owned", () => {
    const trend = createOrderOwnership({ strategyId: "trend", instanceId: "a1" });
    const guardian = createOrderOwnership({
      strategyId: "guardian",
      instanceId: "a1",
    });
    const otherInstance = createOrderOwnership({
      strategyId: "trend",
      instanceId: "b2",
    });
    const id = buildClientOrderId({
      ownership: trend,
      purpose: "stop",
      sequence: 1,
    });
    expect(isBotOwned(id, guardian)).toBe(false);
    expect(isBotOwned(id, otherInstance)).toBe(false);
    expect(isBotOwned("manual-order", trend)).toBe(false);
  });

  it("truncates a long instance segment so the id stays within 36 characters", () => {
    const ownership = createOrderOwnership({
      strategyId: "liquidity-maker",
      instanceId: "local-01",
    });
    const id = buildClientOrderId({
      ownership,
      purpose: "exit",
      sequence: 91,
    });
    expect(id.length).toBeLessThanOrEqual(CLIENT_ORDER_ID_MAX_LEN);
    expect(isBotOwned(id, ownership)).toBe(true);
    expect(id.startsWith(`${CLIENT_ORDER_APP_PREFIX}-liquidity-maker-`)).toBe(
      true,
    );
  });

  it("continues sequence from existing owned ids after restart", () => {
    const ownership = createOrderOwnership({ strategyId: "maker", instanceId: "a1" });
    const existing = [
      buildClientOrderId({ ownership, purpose: "bid", sequence: 87 }),
      "manual-keep-me",
    ];
    expect(nextClientOrderSequence(existing, ownership)).toBe(88);
  });

  it("parses purpose and sequence from an owned id", () => {
    const ownership = createOrderOwnership({ strategyId: "trend", instanceId: "a1" });
    const id = buildClientOrderId({
      ownership,
      purpose: "entry",
      sequence: 7,
    });
    expect(parseOwnedClientOrderId(id, ownership)).toEqual({
      purpose: "entry",
      sequence: 7,
    });
    expect(purposeOf({
      type: "PLACE_STOP",
      strategyId: "trend",
      symbol: "BTCUSDT",
      side: "SELL",
      stopPrice: 1,
      quantity: 0.001,
      reduceOnly: true,
    })).toBe("stop");
  });
});
