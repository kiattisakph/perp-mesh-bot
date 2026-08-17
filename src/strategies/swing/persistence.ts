import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { initialSwingState, type SwingState } from "./state";

export const SWING_STATE_SCHEMA_VERSION = 1;

export class SwingStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwingStateError";
  }
}

export type PersistedSwingState = SwingState & {
  version: number;
};

export function swingStateFilePath(
  instanceId: string,
  dataDir = "data",
): string {
  if (instanceId.trim() === "") {
    throw new RangeError("instanceId must be non-empty");
  }
  if (instanceId.includes("/") || instanceId.includes("\\")) {
    throw new RangeError("instanceId must not contain path separators");
  }
  return join(dataDir, `swing-state-${instanceId}.json`);
}

function isBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

function parsePreviousRsi(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SwingStateError("previousRsi must be a finite number or null");
  }
  if (value < 0 || value > 100) {
    throw new SwingStateError("previousRsi must be between 0 and 100");
  }
  return value;
}

export function parseSwingState(value: unknown): SwingState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SwingStateError("swing state must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SWING_STATE_SCHEMA_VERSION) {
    throw new SwingStateError(
      `swing state version must be ${SWING_STATE_SCHEMA_VERSION}`,
    );
  }
  if (
    !isBoolean(record.armedShortEntry) ||
    !isBoolean(record.armedShortExit) ||
    !isBoolean(record.armedLongEntry) ||
    !isBoolean(record.armedLongExit)
  ) {
    throw new SwingStateError("armed flags must be booleans");
  }
  return {
    previousRsi: parsePreviousRsi(record.previousRsi),
    armedShortEntry: record.armedShortEntry,
    armedShortExit: record.armedShortExit,
    armedLongEntry: record.armedLongEntry,
    armedLongExit: record.armedLongExit,
  };
}

export function serializeSwingState(state: SwingState): PersistedSwingState {
  return {
    version: SWING_STATE_SCHEMA_VERSION,
    previousRsi: state.previousRsi,
    armedShortEntry: state.armedShortEntry,
    armedShortExit: state.armedShortExit,
    armedLongEntry: state.armedLongEntry,
    armedLongExit: state.armedLongExit,
  };
}

/**
 * Missing file: start unarmed (first run). Corrupt file: fail-fast.
 * swing.md TBD is fail-fast vs start unarmed for missing/corrupt; validation
 * is required. First run has no file; corrupt JSON/schema throws.
 */
export function loadSwingState(filePath: string): SwingState {
  if (!existsSync(filePath)) {
    return initialSwingState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new SwingStateError(`swing state file is not valid JSON: ${filePath}`);
  }
  return parseSwingState(parsed);
}

export function saveSwingState(filePath: string, state: SwingState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const payload = `${JSON.stringify(serializeSwingState(state), null, 2)}\n`;
  try {
    writeFileSync(tmpPath, payload, "utf8");
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may already be gone after a successful rename
    }
    throw error;
  }
}
