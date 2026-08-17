import type { KillSwitchMode } from "../config/schema";
import type { AccountState, FuturesPosition } from "../domain/account";
import type { OrderIntent } from "../domain/intent";
import { absQuantity, closeSide, isFlat } from "../domain/position";
import { isSendableQuantity, roundCloseQuantity } from "../domain/rounding";
import type { SymbolPrecision } from "../domain/strategy";
import { isMarkSlippageAllowed } from "./slippage";

export type KillSwitchContext = {
  symbol: string;
  strategyId: string;
  position: FuturesPosition | null;
  entryClientOrderIds: string[];
  precision: SymbolPrecision;
  markPrice: number | undefined;
  closeCandidatePrice: number | undefined;
  maxCloseSlippageFraction: number;
};

export function killSwitchIntents(
  mode: KillSwitchMode,
  context: KillSwitchContext,
): OrderIntent[] {
  const intents: OrderIntent[] = [];
  if (context.entryClientOrderIds.length > 0) {
    intents.push({
      type: "CANCEL",
      strategyId: context.strategyId,
      orderIds: context.entryClientOrderIds,
    });
  }

  if (mode !== "CANCEL_AND_FLATTEN") {
    return intents;
  }

  const position = context.position;
  if (position === null || isFlat(position.quantity)) {
    return intents;
  }
  if (context.markPrice === undefined) {
    return intents;
  }
  const candidate = context.closeCandidatePrice ?? context.markPrice;
  if (
    !isMarkSlippageAllowed(
      candidate,
      context.markPrice,
      context.maxCloseSlippageFraction,
    )
  ) {
    return intents;
  }
  const quantity = roundCloseQuantity(
    absQuantity(position.quantity),
    absQuantity(position.quantity),
    context.precision,
    "market",
  );
  if (!isSendableQuantity(quantity)) {
    return intents;
  }
  intents.push({
    type: "PLACE_MARKET",
    strategyId: context.strategyId,
    symbol: context.symbol,
    side: closeSide(position.quantity),
    quantity,
    reduceOnly: true,
    reason: "kill_switch_flatten",
  });
  return intents;
}

export class KillSwitch {
  private engaged: KillSwitchMode | undefined;

  constructor(private readonly defaultMode: KillSwitchMode) {}

  get mode(): KillSwitchMode | undefined {
    return this.engaged;
  }

  get isEngaged(): boolean {
    return this.engaged !== undefined;
  }

  engage(mode: KillSwitchMode = this.defaultMode): KillSwitchMode {
    this.engaged = mode;
    return mode;
  }

  plan(context: KillSwitchContext): OrderIntent[] {
    if (this.engaged === undefined) {
      return [];
    }
    return killSwitchIntents(this.engaged, context);
  }

  isFlat(account: AccountState, symbol: string): boolean {
    const position = account.positions.find((row) => row.symbol === symbol);
    return position === undefined || isFlat(position.quantity);
  }
}
