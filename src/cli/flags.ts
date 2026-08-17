import { ConfigError } from "../config/env";
import { STRATEGY_NAMES, type StrategyName } from "../config/schema";
import { CONFIRM_PRODUCTION_FLAG } from "../application/production/confirmation";

export type CliFlags = {
  strategy?: StrategyName;
  symbol?: string;
  dryRun: boolean;
  testnet: boolean;
  readOnly: boolean;
  cancelOnly: boolean;
  flattenOnExit: boolean;
  confirmProduction: boolean;
};

const BOOLEAN_FLAGS = new Set([
  "--dry-run",
  "--testnet",
  "--read-only",
  "--cancel-only",
  "--flatten-on-exit",
  CONFIRM_PRODUCTION_FLAG,
]);

function takeValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string; next: number } {
  const current = argv[index];
  const eq = current.indexOf("=");
  if (eq >= 0) {
    const value = current.slice(eq + 1);
    if (value === "") {
      throw new ConfigError(`${flag} requires a value`, [flag]);
    }
    return { value, next: index + 1 };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("-")) {
    throw new ConfigError(`${flag} requires a value`, [flag]);
  }
  return { value: next, next: index + 2 };
}

export function parseCliFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {
    dryRun: false,
    testnet: false,
    readOnly: false,
    cancelOnly: false,
    flattenOnExit: false,
    confirmProduction: false,
  };

  let i = 0;
  while (i < argv.length) {
    const raw = argv[i] ?? "";
    const name = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
    if (name === "--strategy") {
      const taken = takeValue(argv, i, "--strategy");
      if (!(STRATEGY_NAMES as readonly string[]).includes(taken.value)) {
        throw new ConfigError(
          `--strategy must be one of: ${STRATEGY_NAMES.join(", ")}`,
          ["--strategy"],
        );
      }
      flags.strategy = taken.value as StrategyName;
      i = taken.next;
      continue;
    }
    if (name === "--symbol") {
      const taken = takeValue(argv, i, "--symbol");
      flags.symbol = taken.value.trim().toUpperCase();
      i = taken.next;
      continue;
    }
    if (!BOOLEAN_FLAGS.has(name)) {
      throw new ConfigError(`unknown flag ${name}`, [name]);
    }
    if (name === "--dry-run") {
      flags.dryRun = true;
    } else if (name === "--testnet") {
      flags.testnet = true;
    } else if (name === "--read-only") {
      flags.readOnly = true;
    } else if (name === "--cancel-only") {
      flags.cancelOnly = true;
    } else if (name === "--flatten-on-exit") {
      flags.flattenOnExit = true;
    } else if (name === CONFIRM_PRODUCTION_FLAG) {
      flags.confirmProduction = true;
    }
    i += 1;
  }

  if (flags.cancelOnly && flags.flattenOnExit) {
    throw new ConfigError(
      "--cancel-only and --flatten-on-exit cannot be set together",
      ["--cancel-only", "--flatten-on-exit"],
    );
  }

  return flags;
}
