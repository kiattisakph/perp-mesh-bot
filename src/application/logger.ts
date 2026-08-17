import type { StrategyLog } from "../domain/strategy";

const FORBIDDEN =
  /^(api[_-]?key|api[_-]?secret|secret|signature|authorization|binanceApiKey|binanceApiSecret)$/i;

function redact(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (FORBIDDEN.test(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function emitStrategyLog(
  log: StrategyLog,
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): void {
  const payload: StrategyLog = {
    ...log,
    details: redact(log.details),
  };
  write(JSON.stringify(payload));
}

export function createStrategyLogger(context: {
  strategyId: string;
  instanceId: string;
  symbol: string;
  now?: () => number;
}): (event: string, details?: Record<string, unknown>, level?: StrategyLog["level"]) => void {
  const now = context.now ?? Date.now;
  return (event, details, level = "info") => {
    emitStrategyLog({
      timestamp: new Date(now()).toISOString(),
      level,
      strategyId: context.strategyId,
      instanceId: context.instanceId,
      symbol: context.symbol,
      event,
      details,
    });
  };
}
