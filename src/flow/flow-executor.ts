import type { Unsubscribe } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import { createMessage, type IntegrationMessage } from '../message';
import type { TraceContext } from '../trace/trace-context';
import type { BuiltFlow } from './integration-flow';
import type { FlowStepContext, StepOutcome } from './flow-step';

/** Port minimo de idempotency (implementado por IdempotencyService en Fase 5). */
export interface FlowIdempotencyPort {
  begin(scope: string, key: string, ttlMs: number): Promise<boolean>;
  complete(scope: string, key: string, result: Record<string, unknown>): Promise<void>;
  fail(scope: string, key: string, error: unknown): Promise<void>;
}

export interface FlowDeps {
  registry: ChannelRegistry;
  trace: TraceContext;
  errorChannel: string;
  idempotency?: FlowIdempotencyPort;
  idempotencyTtlMs?: number;
}

export type FlowExecutionStatus = 'completed' | 'filtered' | 'duplicate';

export interface FlowExecutionResult {
  status: FlowExecutionStatus;
  msg?: IntegrationMessage;
}

const DEFAULT_IDEMPOTENCY_TTL_MS = 3_600_000;

/**
 * Template Method (GoF — plan sec.9.4): acquire idempotency -> TraceContext.run ->
 * chain de steps -> succeed | fail->error.channel | duplicate->silence (spec sec.6.4).
 */
export class FlowExecutor {
  constructor(
    readonly flowName: string,
    private readonly built: BuiltFlow,
    private readonly deps: FlowDeps,
  ) {}

  inspect(): { source: string; steps: Record<string, unknown>[] } {
    return { source: this.built.source, steps: this.built.steps.map((s) => s.describe()) };
  }

  /** Subscribes la execution al channel source (el modulo lo uses en Fase 10). */
  attachTo(registry: ChannelRegistry): Unsubscribe {
    // El handler RETORNA la promesa: en channels awaited (direct) el send
    // del productor awaits la execution completa del flow (spec sec.17.3).
    return registry
      .get(this.built.source)
      .subscribe((msg) => this.execute(msg).then(() => undefined));
  }

  async execute(input: IntegrationMessage): Promise<FlowExecutionResult> {
    const scope = `flow:${this.flowName}`;
    const key =
      typeof input.headers.idempotencyKey === 'string' ? input.headers.idempotencyKey : undefined;
    const idem = this.deps.idempotency;
    const ttl = this.deps.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    if (idem !== undefined && key !== undefined) {
      const acquired = await idem.begin(scope, key, ttl);
      if (!acquired) return { status: 'duplicate' };
    }
    try {
      const result = await this.deps.trace.runWithMessage(input, () => this.runSteps(input));
      if (idem !== undefined && key !== undefined) {
        await idem.complete(
          scope,
          key,
          result.status === 'filtered' ? { filtered: true } : { completed: true },
        );
      }
      return result;
    } catch (error) {
      if (idem !== undefined && key !== undefined) {
        await idem.fail(scope, key, error).catch(() => undefined);
      }
      await this.reportError(input, error).catch(() => undefined);
      throw error;
    }
  }

  private async runSteps(input: IntegrationMessage): Promise<FlowExecutionResult> {
    let msg = input;
    for (const step of this.built.steps) {
      let outcome: StepOutcome;
      try {
        outcome = await step.execute(this.context(msg));
      } catch (error) {
        outcome = { action: 'fail', error };
      }
      if (outcome.action === 'continue') {
        msg = outcome.msg;
        continue;
      }
      if (outcome.action === 'stop') {
        return outcome.reason === 'filtered'
          ? { status: 'filtered', msg }
          : { status: 'completed', msg };
      }
      throw outcome.error;
    }
    return { status: 'completed', msg };
  }

  private context(msg: IntegrationMessage): FlowStepContext {
    return {
      msg,
      registry: this.deps.registry,
      trace: this.deps.trace,
      errorChannel: this.deps.errorChannel,
      flowName: this.flowName,
    };
  }

  private async reportError(input: IntegrationMessage, error: unknown): Promise<void> {
    const envelope = createMessage(
      { flow: this.flowName, error, causedBy: input.headers.id },
      {
        traceId: input.headers.traceId,
        correlationId: input.headers.correlationId,
        causationId: input.headers.id,
        parentSpanId: input.headers.spanId,
      },
    );
    await this.deps.registry.sendMessage(this.deps.errorChannel, envelope);
  }
}
