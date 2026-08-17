import type { KillSwitchMode } from "../config/schema";
import type { FuturesPosition } from "../domain/account";
import type { OrderIntent } from "../domain/intent";
import type { TradingOrder } from "../domain/order";
import type { SymbolPrecision } from "../domain/strategy";
import { killSwitchIntents } from "../risk/kill-switch";
import { ExecutionService } from "./execution-service";
import type { ExecutionVenue } from "./execution-venue";
import { isBotOwned, ownedEntryClientOrderIds, type OrderOwnership } from "./ownership";

export type ShutdownMode = "cancel-owned" | "cancel-only" | "flatten";

export type ShutdownContext = {
  symbol: string;
  strategyId: string;
  ownership: OrderOwnership;
  position: FuturesPosition | null;
  openOrders: TradingOrder[];
  precision: SymbolPrecision;
  markPrice: number | undefined;
  closeCandidatePrice: number | undefined;
  maxCloseSlippageFraction: number;
};

function toKillMode(mode: ShutdownMode): KillSwitchMode | undefined {
  if (mode === "cancel-only") {
    return "CANCEL_ONLY";
  }
  if (mode === "flatten") {
    return "CANCEL_AND_FLATTEN";
  }
  return undefined;
}

function ownedLive(
  openOrders: readonly TradingOrder[],
  ownership: OrderOwnership,
): TradingOrder[] {
  return openOrders.filter(
    (order) =>
      (order.status === "NEW" || order.status === "PARTIALLY_FILLED") &&
      isBotOwned(order.clientOrderId, ownership),
  );
}

export function shutdownIntents(
  mode: ShutdownMode,
  context: ShutdownContext,
): OrderIntent[] {
  const killMode = toKillMode(mode);
  if (killMode !== undefined) {
    return killSwitchIntents(killMode, {
      symbol: context.symbol,
      strategyId: context.strategyId,
      position: context.position,
      entryClientOrderIds: ownedEntryClientOrderIds(
        context.openOrders,
        context.ownership,
      ),
      precision: context.precision,
      markPrice: context.markPrice,
      closeCandidatePrice: context.closeCandidatePrice,
      maxCloseSlippageFraction: context.maxCloseSlippageFraction,
    });
  }
  const owned = ownedLive(context.openOrders, context.ownership);
  if (owned.length === 0) {
    return [];
  }
  return [
    {
      type: "CANCEL",
      strategyId: context.strategyId,
      orderIds: owned.map((order) => order.clientOrderId),
    },
  ];
}

export class ShutdownService {
  constructor(
    private readonly execution: ExecutionService,
    private readonly venue: ExecutionVenue,
  ) {}

  async shutdown(mode: ShutdownMode, context: ShutdownContext): Promise<void> {
    const intents = shutdownIntents(mode, context);
    if (intents.length === 0) {
      return;
    }
    await this.execution.execute(intents, {
      symbol: context.symbol,
      ownership: context.ownership,
      openOrders: context.openOrders,
    });
    await this.venue.fetchOpenOrders(context.symbol);
    if (mode === "flatten") {
      await this.venue.fetchAccount(context.symbol);
    }
  }
}
