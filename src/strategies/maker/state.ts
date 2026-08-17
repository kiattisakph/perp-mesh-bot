export type MakerQuotingState =
  | "STARTING"
  | "RECONCILING"
  | "FLAT_QUOTING"
  | "POSITION_EXIT_ONLY"
  | "DEGRADED"
  | "PAUSED"
  | "KILL_SWITCH";

export type MakerState = {
  phase: MakerQuotingState;
};

export function initialMakerState(): MakerState {
  return { phase: "STARTING" };
}
