export type TimerHandle = number;

export type SoakClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(id: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(id: TimerHandle): void;
  outstanding(): number;
  advanceTo?(target: number): void;
};

/**
 * Clock used by soak to prove timers are cleared on stop. Real Date.now /
 * setTimeout are wrapped; tests inject a manual clock.
 */
export class TrackedClock implements SoakClock {
  private nextId = 1;
  private readonly timeouts = new Map<TimerHandle, ReturnType<typeof setTimeout>>();
  private readonly intervals = new Map<TimerHandle, ReturnType<typeof setInterval>>();

  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timeouts.set(
      id,
      setTimeout(() => {
        this.timeouts.delete(id);
        fn();
      }, ms),
    );
    return id;
  }

  clearTimeout(id: TimerHandle): void {
    const handle = this.timeouts.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timeouts.delete(id);
    }
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.intervals.set(id, setInterval(fn, ms));
    return id;
  }

  clearInterval(id: TimerHandle): void {
    const handle = this.intervals.get(id);
    if (handle !== undefined) {
      clearInterval(handle);
      this.intervals.delete(id);
    }
  }

  outstanding(): number {
    return this.timeouts.size + this.intervals.size;
  }

  clearAll(): void {
    for (const handle of this.timeouts.values()) {
      clearTimeout(handle);
    }
    this.timeouts.clear();
    for (const handle of this.intervals.values()) {
      clearInterval(handle);
    }
    this.intervals.clear();
  }
}

export class ManualClock implements SoakClock {
  private nextId = 1;
  private readonly timers = new Map<
    TimerHandle,
    { at: number; fn: () => void; intervalMs?: number }
  >();

  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + ms, fn });
    return id;
  }

  clearTimeout(id: TimerHandle): void {
    this.timers.delete(id);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + ms, fn, intervalMs: ms });
    return id;
  }

  clearInterval(id: TimerHandle): void {
    this.timers.delete(id);
  }

  outstanding(): number {
    return this.timers.size;
  }

  advanceTo(target: number): void {
    while (true) {
      let next: { id: TimerHandle; at: number; fn: () => void; intervalMs?: number } | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) {
          continue;
        }
        if (next === undefined || timer.at < next.at) {
          next = { id, ...timer };
        }
      }
      if (next === undefined) {
        this.current = target;
        return;
      }
      this.current = next.at;
      if (next.intervalMs !== undefined) {
        const repeating = this.timers.get(next.id);
        if (repeating !== undefined) {
          repeating.at = this.current + next.intervalMs;
        }
      } else {
        this.timers.delete(next.id);
      }
      next.fn();
    }
  }
}

export type LeakSnapshot = {
  timersOutstanding: number;
  heapUsedBytes: number;
};

export function leakSnapshot(clock: SoakClock): LeakSnapshot {
  return {
    timersOutstanding: clock.outstanding(),
    heapUsedBytes: process.memoryUsage().heapUsed,
  };
}
