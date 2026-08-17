import type { KillSwitch } from "../../risk/kill-switch";

export type ProcessSignals = {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): void;
};

/**
 * Operator backup to in-runtime kill-switch.engage(): SIGINT/SIGTERM engage
 * the same KillSwitch modes (`CANCEL_ONLY` / `CANCEL_AND_FLATTEN`).
 */
export class BackupKillSwitch {
  private armed = false;
  private readonly handle = (): void => {
    if (this.killSwitch.isEngaged) {
      return;
    }
    this.killSwitch.engage();
    void this.onEngaged();
  };

  constructor(
    private readonly killSwitch: KillSwitch,
    private readonly onEngaged: () => void | Promise<void>,
    private readonly signals: ProcessSignals,
  ) {}

  arm(): void {
    if (this.armed) {
      return;
    }
    this.signals.on("SIGINT", this.handle);
    this.signals.on("SIGTERM", this.handle);
    this.armed = true;
  }

  disarm(): void {
    if (!this.armed) {
      return;
    }
    this.signals.off("SIGINT", this.handle);
    this.signals.off("SIGTERM", this.handle);
    this.armed = false;
  }
}
