import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SWING_STATE_SCHEMA_VERSION,
  SwingStateError,
  initialSwingState,
  loadSwingState,
  saveSwingState,
  swingStateFilePath,
} from "../../src/strategies/swing";

describe("Swing armed-state persistence", () => {
  it("round-trips armed flags with schema version via atomic write", () => {
    const dir = mkdtempSync(join(tmpdir(), "swing-state-"));
    const path = swingStateFilePath("a1", dir);
    const state = {
      previousRsi: 71,
      armedShortEntry: true,
      armedShortExit: false,
      armedLongEntry: false,
      armedLongExit: false,
    };
    saveSwingState(path, state);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version: number };
    expect(raw.version).toBe(SWING_STATE_SCHEMA_VERSION);
    expect(loadSwingState(path)).toEqual(state);
  });

  it("starts unarmed when the state file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "swing-state-"));
    expect(loadSwingState(swingStateFilePath("missing", dir))).toEqual(
      initialSwingState(),
    );
  });

  it("fails fast on corrupt JSON or a wrong schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "swing-state-"));
    const path = swingStateFilePath("bad", dir);
    writeFileSync(path, "{not-json", "utf8");
    expect(() => loadSwingState(path)).toThrow(SwingStateError);

    saveSwingState(path, initialSwingState());
    writeFileSync(
      path,
      JSON.stringify({
        version: 99,
        previousRsi: null,
        armedShortEntry: false,
        armedShortExit: false,
        armedLongEntry: false,
        armedLongExit: false,
      }),
      "utf8",
    );
    expect(() => loadSwingState(path)).toThrow(/version/);
  });
});
