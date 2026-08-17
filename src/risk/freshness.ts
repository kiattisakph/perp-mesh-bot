export function isFeedStale(input: {
  eventTime: number;
  now: number;
  staleMs: number;
}): boolean {
  const { eventTime, now, staleMs } = input;
  if (!Number.isFinite(eventTime) || !Number.isFinite(now)) {
    return true;
  }
  if (!Number.isFinite(staleMs) || staleMs <= 0) {
    throw new RangeError("staleMs must be finite and greater than 0");
  }
  return now - eventTime > staleMs;
}

export type FeedFreshness = {
  depthStale: boolean;
  userStreamStale: boolean;
  accountStale: boolean;
  marketStale: boolean;
};

export function anyRequiredFeedStale(freshness: FeedFreshness): boolean {
  return (
    freshness.depthStale ||
    freshness.userStreamStale ||
    freshness.accountStale ||
    freshness.marketStale
  );
}
