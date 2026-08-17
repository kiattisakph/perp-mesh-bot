export type TrendPhase =
  | "FLAT"
  | "OPENING_LONG"
  | "OPENING_SHORT"
  | "IN_POSITION"
  | "PROTECTING";

export type TrendState = {
  phase: TrendPhase;
  previousPrice?: number;
  lastEntryAt?: number;
  lastStopAt?: number;
};

export function initialTrendState(): TrendState {
  return { phase: "FLAT" };
}
