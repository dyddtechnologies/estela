import type { Unsubscribe } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import { createMessage, type IntegrationMessage } from '../message';
import { CareScope, parseTriesLeft, TRIES_LEFT_MESSAGE_HEADER } from '../resilience/retry-budget';
import type { CareEngine } from '../resilience/runtime';
import type { TraceContext } from '../trace/trace-context';
import type { HopLogger } from '../trace/hop-logger';
import type { BuiltFlow } from './integration-flow';
import type { FlowStepContext, StepOutcome, StepCarePort } from './flow-step';

/** Minimal idempotency port (implemented by IdempotencyService). */
export interface FlowIdempotencyPort {
  begin(scope: string, key: string, ttlMs: number): Promise<boolean>;
  complete(scope: string, key: string, result: Record<string, unknown>): Promise<void>;
  fail(scope: string, key: string, error: unknown): Promise<void>;
  /** True when the store can free a key; a run that plan B answered then releases its claim (RS-64). */
  readonly supportsRelease?: boolean;
  release?(scope: string, key: string): Promise<unknown>;
}

export interface FlowDeps {
  registry: ChannelRegistry;
  trace: TraceContext;
  errorChannel: string;
  idempotency?: FlowIdempotencyPort;
  idempotencyTtlMs?: number;
  logger?: HopLogger;
  /**
   * Care engine: the flow opens a message scope per run (tries left when enabled, plan B mark,
   * RS-64, RS-65). Without it the flow runs exactly as in 0.9.0.
   */
  care?: CareEngine;
  /** Resolved step care by step index (`FlowParameterResolver`); absent = none. */
  stepCare?: readonly (StepCarePort | undefined)[];
}

export type FlowExecutionStatus = 'completed' | 'filtered' | 'duplicate';

export interface FlowExecutionResult {
  status: FlowExecutionStatus;
  msg?: IntegrationMessage;
}

interface RunFrame {
  planB(): boolean;
}

const DEFAULT_IDEMPOTENCY_TTL_MS = 3_600_000;

/**
 * Template Method (GoF, plan sec.9.4): acquire idempotency -> TraceContext.run ->
 * chain of steps -> succeed | fail->error.channel | duplicate->silence (spec sec.6.4).
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

  /** Subscribes the execution to the source channel. */
  attachTo(registry: ChannelRegistry): Unsubscribe {
    // The handler RETURNS the promise: on awaited channels (direct) the producer's send
    // awaits the whole flow execution (spec sec.17.3).
    return registry
      .get(this.built.source)
      .subscribe((msg) => this.execute(msg).then(() => undefined));
  }

  execute(input: IntegrationMessage): Promise<FlowExecutionResult> {
    const engine = this.deps.care;
    if (engine === undefined) return this.executeInScope(input, undefined);
    // RS-64, RS-65: one message scope per run, rebuilt from the headers (invariant 7).
    const triesLeft = engine.enabled
      ? parseTriesLeft(input.headers[TRIES_LEFT_MESSAGE_HEADER])
      : undefined;
    const value = {
      traceId: input.headers.traceId,
      fromEventsChannel: this.built.source === engine.eventsChannel,
      ...(triesLeft === undefined ? {} : { triesLeft }),
    };
    return CareScope.runMessage(value, (frame) => this.executeInScope(input, frame));
  }

  private async executeInScope(
    input: IntegrationMessage,
    frame: RunFrame | undefined,
  ): Promise<FlowExecutionResult> {
    const scope = `flow:${this.flowName}`;
    const claim = this.claimOf(input);
    if (claim !== undefined) {
      const ttl = this.deps.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
      const acquired = await claim.idem.begin(scope, claim.key, ttl);
      if (!acquired) return { status: 'duplicate' };
    }
    try {
      const result = await this.runTracked(input, frame);
      if (claim !== undefined) {
        await settleClaim(claim.idem, scope, claim.key, result, frame?.planB() === true);
      }
      return result;
    } catch (error) {
      if (claim !== undefined) {
        await claim.idem.fail(scope, claim.key, error).catch(() => undefined);
      }
      await this.reportError(input, error).catch(() => undefined);
      throw error;
    }
  }

  /** The flow claim of this message: a store and a message key (spec sec.6.4). */
  private claimOf(
    input: IntegrationMessage,
  ): { idem: FlowIdempotencyPort; key: string } | undefined {
    const key = input.headers.idempotencyKey;
    const idem = this.deps.idempotency;
    if (typeof key !== 'string' || idem === undefined) return undefined;
    return { idem, key };
  }

  /** Runs the steps under the message trace, bracketed by the optional hop logger. */
  private async runTracked(
    input: IntegrationMessage,
    frame: RunFrame | undefined,
  ): Promise<FlowExecutionResult> {
    const log = this.deps.logger;
    const run = (): Promise<FlowExecutionResult> => this.runSteps(input, frame);
    if (log === undefined) {
      return this.deps.trace.runWithMessage(input, run);
    }
    const { source } = this.built;
    const startedAt = Date.now();
    log.flowStart(this.flowName, source, input.headers);
    try {
      const result = await this.deps.trace.runWithMessage(input, run);
      log.flowEnd(this.flowName, source, input.headers, result.status, Date.now() - startedAt);
      return result;
    } catch (error) {
      log.flowEnd(this.flowName, source, input.headers, 'error', Date.now() - startedAt);
      throw error;
    }
  }

  private async runSteps(
    input: IntegrationMessage,
    frame: RunFrame | undefined,
  ): Promise<FlowExecutionResult> {
    let msg = input;
    for (const [index, step] of this.built.steps.entries()) {
      let outcome: StepOutcome;
      try {
        outcome = await step.execute(this.context(msg, index, frame));
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

  private context(
    msg: IntegrationMessage,
    index: number,
    frame: RunFrame | undefined,
  ): FlowStepContext {
    const ctx: FlowStepContext = {
      msg,
      registry: this.deps.registry,
      trace: this.deps.trace,
      errorChannel: this.deps.errorChannel,
      flowName: this.flowName,
    };
    const care = this.deps.stepCare?.[index];
    if (care !== undefined) ctx.care = care;
    if (frame !== undefined) ctx.planB = () => frame.planB();
    return ctx;
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

/**
 * Completes the flow claim, except on a run that plan B answered (RS-64, RS-27): a plan B result
 * is never stored, so the claim is released when the store can, else marked failed.
 */
async function settleClaim(
  idem: FlowIdempotencyPort,
  scope: string,
  key: string,
  result: FlowExecutionResult,
  planB: boolean,
): Promise<void> {
  if (!planB) {
    await idem.complete(
      scope,
      key,
      result.status === 'filtered' ? { filtered: true } : { completed: true },
    );
    return;
  }
  if (idem.supportsRelease === true && idem.release !== undefined) {
    await idem.release(scope, key);
    return;
  }
  await idem.fail(scope, key, new Error('plan B result not stored'));
}
