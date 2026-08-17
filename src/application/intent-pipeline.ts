import type { OrderIntent } from "../domain/intent";
import { RateLimitError } from "../infrastructure/binance-usdm/errors";
import { ExecutionService, type ExecutionResult } from "./execution-service";
import { filterIntents, type RiskContext, type RiskDecision } from "./risk-service";
import type { RateLimitMachine } from "../risk/rate-limit";

export type PipelineLog = (
  event: string,
  details?: Record<string, unknown>,
) => void;

export type PipelineResult = {
  risk: RiskDecision;
  execution: ExecutionResult | undefined;
};

export class IntentPipeline {
  constructor(
    private readonly execution: ExecutionService,
    private readonly rateLimit: RateLimitMachine,
    private readonly log?: PipelineLog,
    private readonly now: () => number = Date.now,
  ) {}

  async run(
    intents: readonly OrderIntent[],
    context: RiskContext,
  ): Promise<PipelineResult> {
    const risk = filterIntents(intents, {
      ...context,
      inFlight: [...context.inFlight, ...this.execution.inFlightOrders()],
      rateLimitState: this.rateLimit.state,
    });
    for (const rejected of risk.rejected) {
      this.log?.("intent_rejected", {
        reason: rejected.reason,
        type: rejected.intent.type,
      });
    }
    if (risk.allowed.length === 0) {
      return { risk, execution: undefined };
    }
    try {
      const execution = await this.execution.execute(risk.allowed, {
        symbol: context.symbol,
        ownership: context.ownership,
        openOrders: context.openOrders,
      });
      this.rateLimit.onSuccess(this.now());
      return { risk, execution };
    } catch (error) {
      if (error instanceof RateLimitError) {
        this.rateLimit.on429(this.now());
        this.log?.("rate_limit", {
          httpStatus: error.httpStatus,
          state: this.rateLimit.state,
        });
      }
      throw error;
    }
  }
}
