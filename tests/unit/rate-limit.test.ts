import { describe, expect, it } from "vitest";
import { RateLimitMachine } from "../../src/risk/rate-limit";

function machine(): RateLimitMachine {
  return new RateLimitMachine({
    cleanWindowMs: 100,
    pausedCooldownMs: 200,
    repeated429WhileDegraded: 1,
  });
}

describe("rate-limit state machine", () => {
  it("moves NORMAL → DEGRADED on the first 429 and blocks entry", () => {
    const rateLimit = machine();
    expect(rateLimit.state).toBe("NORMAL");
    expect(rateLimit.allowsEntry()).toBe(true);
    expect(rateLimit.on429(0)).toBe("DEGRADED");
    expect(rateLimit.allowsEntry()).toBe(false);
    expect(rateLimit.allowsProtection()).toBe(true);
    expect(rateLimit.pollMultiplier()).toBe(2);
  });

  it("moves DEGRADED → PAUSED on a repeated 429", () => {
    const rateLimit = machine();
    rateLimit.on429(0);
    expect(rateLimit.on429(10)).toBe("PAUSED");
    expect(rateLimit.allowsEntry()).toBe(false);
    expect(rateLimit.allowsProtection()).toBe(true);
  });

  it("returns DEGRADED → NORMAL after a clean window of successes", () => {
    const rateLimit = machine();
    rateLimit.on429(0);
    expect(rateLimit.onSuccess(50)).toBe("DEGRADED");
    expect(rateLimit.onSuccess(100)).toBe("NORMAL");
    expect(rateLimit.allowsEntry()).toBe(true);
  });

  it("leaves PAUSED only after cooldown and a healthy probe", () => {
    const rateLimit = machine();
    rateLimit.on429(0);
    rateLimit.on429(1);
    expect(rateLimit.onHealthyProbe(100)).toBe("PAUSED");
    expect(rateLimit.onHealthyProbe(201)).toBe("DEGRADED");
    expect(rateLimit.allowsEntry()).toBe(false);
  });
});
