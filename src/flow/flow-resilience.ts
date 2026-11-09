import { openFirstMessageWait } from '../channels/one-shot';
import { JUMP_REPLY_HEADER, newId, nextHop, type IntegrationMessage } from '../message';
import { defaultInProcessClassifier } from '../resilience/classifiers';
import type {
  ExecuteOptions,
  ResilienceEdgeAdapter,
  ResilienceExecutor,
} from '../resilience/executor';
import type { Classification, ResilienceContext } from '../resilience/resilience.types';
import {
  DEGRADED_HEADER,
  RETRY_BUDGET_MESSAGE_HEADER,
  ResilienceScope,
} from '../resilience/retry-budget';
import { AttemptTimeoutError } from '../resilience/timeout';
import {
  JumpTimeoutError,
  type FlowStepContext,
  type PolicyAttempt,
  type StepPolicyPort,
  type TargetPolicyPort,
} from './flow-step';

export type FlowEdgeKind = 'flow-handle' | 'flow-jump' | 'flow-send';

/** The 0.9.0 jump wait (`jump.step.ts`), kept when no level sets `perAttemptMs` (RS-62). */
export const LEGACY_JUMP_WAIT_MS = 10_000;

const REJECTED_CHANNEL_ERRORS: ReadonlySet<string> = new Set([
  'NoSubscriberError',
  'ChannelNotFoundError',
  'FanoutCycleError',
]);

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * RS-63: channel errors are classified by `name`, never by `instanceof` (a second copy of the
 * package must classify the same way); anything else goes to `defaultInProcessClassifier`.
 */
export function classifyFlowError(edge: FlowEdgeKind, error: unknown): Classification {
  if (edge !== 'flow-handle') {
    const name = errorName(error);
    if (name === 'JumpTimeoutError' && edge === 'flow-jump') return { class: 'transient' };
    if (name === 'CapacityExceededError') return { class: 'throttled' };
    if (name !== undefined && REJECTED_CHANNEL_ERRORS.has(name)) return { class: 'rejected' };
  }
  return defaultInProcessClassifier(error);
}

function messageKey(ctx: ResilienceContext): string | undefined {
  const key = ctx.message?.headers.idempotencyKey;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/** Edge adapter of a flow subject; `repeatable` is the RS-60 key gate. */
export function flowAdapter(
  edge: FlowEdgeKind,
  binding: string,
  channel?: string,
): ResilienceEdgeAdapter {
  return {
    kind: edge,
    classify: (error) => classifyFlowError(edge, error),
    repeatable: (ctx) => messageKey(ctx) !== undefined,
    safe: () => false,
    idempotencyKey: messageKey,
    timeoutError: (_ctx, timeoutMs) =>
      edge === 'flow-jump' && channel !== undefined
        ? new JumpTimeoutError(channel, timeoutMs)
        : new AttemptTimeoutError(binding, timeoutMs),
  };
}

/** The resolved, non-empty policy of one flow subject with its own executor (RS-53). */
export class TargetPolicy implements TargetPolicyPort {
  constructor(
    readonly binding: string,
    readonly edge: FlowEdgeKind,
    readonly channel: string | undefined,
    private readonly executor: ResilienceExecutor<unknown>,
    private readonly options: ExecuteOptions = {},
  ) {}

  async run<T>(
    msg: IntegrationMessage,
    attempt: (a: PolicyAttempt) => Promise<T>,
    data?: unknown,
  ): Promise<{ value: T; fallback: boolean }> {
    const input: Omit<ResilienceContext, 'attempt'> = {
      edge: this.edge,
      binding: this.binding,
      message: msg,
    };
    if (this.channel !== undefined) input.channel = this.channel;
    if (data !== undefined) input.data = data;
    const result = await this.executor.execute(input, attempt, this.options);
    return { value: result.value as T, fallback: result.fallback };
  }
}

/**
 * Policies of one step: static targets by channel, a `handle` policy, or (for `route`) a lazy
 * resolver whose result is cached per channel (RS-67).
 */
export class StepPolicy implements StepPolicyPort {
  private readonly cache = new Map<string, TargetPolicy | null>();

  constructor(
    targets: ReadonlyMap<string, TargetPolicy>,
    readonly handle?: TargetPolicy,
    private readonly lazy?: (channel: string) => TargetPolicy | undefined,
  ) {
    for (const [channel, policy] of targets) this.cache.set(channel, policy);
  }

  target(channel: string): TargetPolicy | undefined {
    const cached = this.cache.get(channel);
    if (cached !== undefined) return cached ?? undefined;
    if (this.lazy === undefined) return undefined;
    // The lazy resolver throws for an unregistered channel, and nothing is cached then.
    const resolved = this.lazy(channel);
    this.cache.set(channel, resolved ?? null);
    return resolved;
  }
}

/** RS-61, RS-65: a shallow copy of the hop for one attempt, with the claimed budget stamped. */
export function attemptCopy(hop: IntegrationMessage, attempt: PolicyAttempt): IntegrationMessage {
  const headers: Record<string, unknown> = { ...hop.headers };
  if (attempt.budgetOut === 0) headers[RETRY_BUDGET_MESSAGE_HEADER] = 0;
  return { payload: hop.payload, headers: headers as IntegrationMessage['headers'] };
}

/**
 * Sends one hop, under the target's policy when it has one. The hop is built once by the caller
 * and every attempt sends an identical shallow copy (RS-61). Without a policy this is the 0.9.0
 * send.
 */
export async function sendHop(
  ctx: FlowStepContext,
  channel: string,
  hop: IntegrationMessage,
): Promise<void> {
  const target = ctx.policy?.target(channel);
  if (target === undefined) {
    await ctx.registry.sendMessage(channel, hop);
    return;
  }
  await target.run(
    ctx.msg,
    (attempt) => ctx.registry.sendMessage(channel, attemptCopy(hop, attempt)),
    { hop },
  );
}

/** RS-64: a reply built while a fallback ran marks the waiting flow run degraded. */
export function markIfDegraded(reply: IntegrationMessage): void {
  if (reply.headers[DEGRADED_HEADER] === true) ResilienceScope.markDegraded();
}

/**
 * RS-62: one jump attempt opens its own `reply.<uuid>`, sends the hop with it, awaits the first
 * reply and, in `finally`, cancels the wait and unregisters the channel, so a late reply to an
 * earlier attempt is dropped.
 */
async function jumpAttempt(
  ctx: FlowStepContext,
  channel: string,
  hop: IntegrationMessage,
  attempt: PolicyAttempt,
): Promise<unknown> {
  const replyName = `reply.${newId()}`;
  const replyChannel = ctx.registry.create({ name: replyName, type: 'direct' });
  const waitMs = attempt.timeoutMs > 0 ? attempt.timeoutMs : LEGACY_JUMP_WAIT_MS;
  const wait = openFirstMessageWait(replyChannel, {
    timeoutMs: waitMs,
    name: channel,
    timeoutError: () => new JumpTimeoutError(channel, waitMs),
  });
  const cancel = (): void => wait.cancel();
  attempt.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const copy = attemptCopy(hop, attempt);
    copy.headers.replyChannel = replyName;
    await ctx.registry.sendMessage(channel, copy);
    const reply = await wait.promise;
    markIfDegraded(reply);
    return reply.payload;
  } finally {
    attempt.signal?.removeEventListener('abort', cancel);
    wait.cancel();
    ctx.registry.unregister(replyName);
  }
}

/** RS-62: a jump target under its policy; the hop is built once and reused by every attempt. */
export function jumpUnderPolicy(
  ctx: FlowStepContext,
  target: TargetPolicyPort,
  channel: string,
): Promise<{ value: unknown; fallback: boolean }> {
  const hop = nextHop(ctx.msg, { channel, component: `jump:${ctx.flowName}` }, { reply: 'none' });
  hop.headers[JUMP_REPLY_HEADER] = '1';
  return target.run(ctx.msg, (attempt) => jumpAttempt(ctx, channel, hop, attempt));
}
