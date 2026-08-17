export type GuardianPhase =
  | "IDLE"
  | "PENDING_PROTECTION"
  | "PROTECTING"
  | "MOVE_STOP"
  | "CLEANUP";

export type GuardianState = {
  phase: GuardianPhase;
};
