import { RECONNECT_INITIAL_MS } from "./endpoints";

export function nextReconnectDelay(attempt: number, maxMs: number): number {
  if (attempt < 0) {
    throw new RangeError("attempt must be >= 0");
  }
  if (!(maxMs > 0)) {
    throw new RangeError("maxMs must be greater than 0");
  }
  return Math.min(RECONNECT_INITIAL_MS * 2 ** attempt, maxMs);
}
