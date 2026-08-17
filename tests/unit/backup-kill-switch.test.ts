import { describe, expect, it } from "vitest";
import { BackupKillSwitch } from "../../src/application/production";
import { KillSwitch } from "../../src/risk/kill-switch";

class FakeSignals {
  readonly listeners = new Map<string, Set<() => void>>();

  on(event: "SIGINT" | "SIGTERM", listener: () => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }

  off(event: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: "SIGINT" | "SIGTERM"): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

describe("backup kill switch", () => {
  it("engages the in-process kill switch on SIGINT and SIGTERM", () => {
    const signals = new FakeSignals();
    const killSwitch = new KillSwitch("CANCEL_ONLY");
    let engaged = 0;
    const backup = new BackupKillSwitch(
      killSwitch,
      () => {
        engaged += 1;
      },
      signals,
    );
    backup.arm();
    signals.emit("SIGINT");
    expect(killSwitch.isEngaged).toBe(true);
    expect(killSwitch.mode).toBe("CANCEL_ONLY");
    expect(engaged).toBe(1);
    signals.emit("SIGTERM");
    expect(engaged).toBe(1);
    backup.disarm();
    expect(signals.listeners.get("SIGINT")?.size ?? 0).toBe(0);
  });

  it("uses CANCEL_AND_FLATTEN when that is the configured mode", () => {
    const signals = new FakeSignals();
    const killSwitch = new KillSwitch("CANCEL_AND_FLATTEN");
    const backup = new BackupKillSwitch(killSwitch, () => undefined, signals);
    backup.arm();
    signals.emit("SIGTERM");
    expect(killSwitch.mode).toBe("CANCEL_AND_FLATTEN");
  });
});
