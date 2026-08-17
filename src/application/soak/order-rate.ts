const MINUTE_MS = 60_000;

export type OrderRateBucket = {
  minuteStart: number;
  places: number;
  cancels: number;
  total: number;
};

/**
 * Numeric orders-per-minute budget is TBD in testing.md. This tracker records
 * the per-minute series and flags a storm when 429 does not reduce place/cancel
 * activity (risk-policy DEGRADED/PAUSED must not keep churning).
 */
export class OrderRateTracker {
  private readonly places: number[] = [];
  private readonly cancels: number[] = [];
  private readonly rateLimitAt: number[] = [];

  recordPlace(now: number, count = 1): void {
    push(this.places, now, count);
  }

  recordCancel(now: number, count = 1): void {
    push(this.cancels, now, count);
  }

  record429(now: number): void {
    this.rateLimitAt.push(now);
  }

  get rateLimitCount(): number {
    return this.rateLimitAt.length;
  }

  buckets(now: number, windowStart: number): OrderRateBucket[] {
    const end = minuteStart(now);
    const start = minuteStart(windowStart);
    const rows: OrderRateBucket[] = [];
    for (let minute = start; minute <= end; minute += MINUTE_MS) {
      const places = countIn(this.places, minute, minute + MINUTE_MS);
      const cancels = countIn(this.cancels, minute, minute + MINUTE_MS);
      rows.push({
        minuteStart: minute,
        places,
        cancels,
        total: places + cancels,
      });
    }
    return rows;
  }

  /**
   * True when place+cancel in the first full minute after a 429 is at least the
   * activity in the 429 minute. That is an order storm: degrade/pause did not
   * reduce cancel/replace.
   */
  hasStormAfter429(now: number, windowStart: number): boolean {
    if (this.rateLimitAt.length === 0) {
      return false;
    }
    const rows = this.buckets(now, windowStart);
    for (const at of this.rateLimitAt) {
      const minute = minuteStart(at);
      const during = rows.find((row) => row.minuteStart === minute);
      const after = rows.find((row) => row.minuteStart === minute + MINUTE_MS);
      if (during === undefined || after === undefined) {
        continue;
      }
      if (after.total > 0 && after.total >= during.total) {
        return true;
      }
    }
    return false;
  }

  /**
   * True when every complete minute's total is strictly larger than the previous
   * (unbounded growth). A flat or varying bounded series is not a storm.
   */
  isUnbounded(now: number, windowStart: number): boolean {
    const complete = this.buckets(now, windowStart).filter(
      (row) => row.minuteStart + MINUTE_MS <= now,
    );
    if (complete.length < 3) {
      return false;
    }
    for (let i = 1; i < complete.length; i += 1) {
      const previous = complete[i - 1];
      const current = complete[i];
      if (previous === undefined || current === undefined) {
        return false;
      }
      if (current.total <= previous.total) {
        return false;
      }
    }
    return true;
  }
}

function minuteStart(now: number): number {
  return Math.floor(now / MINUTE_MS) * MINUTE_MS;
}

function countIn(events: readonly number[], start: number, end: number): number {
  return events.filter((at) => at >= start && at < end).length;
}

function push(target: number[], now: number, count: number): void {
  for (let i = 0; i < count; i += 1) {
    target.push(now);
  }
}
