import type { RateLimitState } from "../domain/strategy";

/**
 * Numeric 429 windows are TBD in risk-policy.md (no env vars). Callers must
 * pass durations so tests can drive transitions without inventing product env.
 */
export type RateLimitConfig = {
  cleanWindowMs: number;
  pausedCooldownMs: number;
  /** Further 429s while already DEGRADED that promote to PAUSED. */
  repeated429WhileDegraded: number;
};

export class RateLimitMachine {
  private current: RateLimitState = "NORMAL";
  private last429At: number | undefined;
  private degraded429Count = 0;
  private pausedAt: number | undefined;

  constructor(private readonly config: RateLimitConfig) {
    if (
      !Number.isFinite(config.cleanWindowMs) ||
      config.cleanWindowMs <= 0 ||
      !Number.isFinite(config.pausedCooldownMs) ||
      config.pausedCooldownMs <= 0 ||
      !Number.isInteger(config.repeated429WhileDegraded) ||
      config.repeated429WhileDegraded < 1
    ) {
      throw new RangeError("rate-limit config must be positive");
    }
  }

  get state(): RateLimitState {
    return this.current;
  }

  allowsEntry(): boolean {
    return this.current === "NORMAL";
  }

  allowsProtection(): boolean {
    return true;
  }

  pollMultiplier(): number {
    return this.current === "NORMAL" ? 1 : 2;
  }

  on429(now: number): RateLimitState {
    this.last429At = now;
    if (this.current === "NORMAL") {
      this.current = "DEGRADED";
      this.degraded429Count = 0;
      this.pausedAt = undefined;
      return this.current;
    }
    if (this.current === "DEGRADED") {
      this.degraded429Count += 1;
      if (this.degraded429Count >= this.config.repeated429WhileDegraded) {
        this.current = "PAUSED";
        this.pausedAt = now;
      }
      return this.current;
    }
    this.pausedAt = now;
    return this.current;
  }

  onSuccess(now: number): RateLimitState {
    if (this.current === "DEGRADED") {
      if (
        this.last429At !== undefined &&
        now - this.last429At >= this.config.cleanWindowMs
      ) {
        this.current = "NORMAL";
        this.degraded429Count = 0;
        this.last429At = undefined;
      }
    }
    return this.current;
  }

  onHealthyProbe(now: number): RateLimitState {
    if (this.current !== "PAUSED") {
      return this.onSuccess(now);
    }
    const pausedAt = this.pausedAt ?? this.last429At;
    if (
      pausedAt !== undefined &&
      now - pausedAt >= this.config.pausedCooldownMs
    ) {
      this.current = "DEGRADED";
      this.degraded429Count = 0;
      this.pausedAt = undefined;
      this.last429At = now;
    }
    return this.current;
  }
}
