import { openFirstMessageWait } from '../channels/one-shot';
import { JUMP_REPLY_HEADER, newId, nextHop, type IntegrationMessage } from '../message';
import { defaultInProcessClassifier } from '../resilience/classifiers';
import type { CareExecuteOptions, CareEdgeAdapter, CareExecutor } from '../resilience/executor';
import type { Classification, CareContext } from '../resilience/resilience.types';
import { PLAN_B_HEADER, TRIES_LEFT_MESSAGE_HEADER, CareScope } from '../resilience/retry-budget';
import { TryOverdueError } from '../resilience/timeout';
import {
  JumpTimeoutError,
  type FlowStepContext,
  type StepTry,
  type StepCarePort,
  type TargetCarePort,
} from './flow-step';

export type FlowEdgeKind = 'flow-handle' | 'flow-jump' | 'flow-send';

/** The 0.9.0 jump wait (`jump.step.ts`), kept when no level sets `eachTryMs` (RS-62). */
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
    if (name === 'CapacityExceededError') return { class: 'busy' };
    if (name !== undefined && REJECTED_CHANNEL_ERRORS.has(name)) return { class: 'rejected' };
  }
  return defaultInProcessClassifier(error);
}

function messageKey(ctx: CareContext): string | undefined {
  const key = ctx.message?.headers.idempotencyKey;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/** Edge adapter of a flow subject; `repeatable` is the RS-60 key gate. */
export function flowAdapter(
  edge: FlowEdgeKind,
  binding: string,
  channel?: string,
): CareEdgeAdapter {
  return {
    kind: edge,
    classify: (error) => classifyFlowError(edge, error),
    repeatable: (ctx) => messageKey(ctx) !== undefined,
    safe: () => false,
    idempotencyKey: messageKey,
    overdueError: (_ctx, eachTryMs) =>
      edge === 'flow-jump' && channel !== undefined
        ? new JumpTimeoutError(channel, eachTryMs)
        : new TryOverdueError(binding, eachTryMs),
  };
}

/** The resolved, non-empty care of one flow subject with its own executor (RS-53). */
export class TargetCare implements TargetCarePort {
  constructor(
    readonly binding: string,
    readonly edge: FlowEdgeKind,
    readonly channel: string | undefined,
    private readonly executor: CareExecutor<unknown>,
    private readonly options: CareExecuteOptions = {},
  ) {}

  async run<T>(
    msg: IntegrationMessage,
    attempt: (current: StepTry) => Promise<T>,
    data?: unknown,
  ): Promise<{ value: T; planB: boolean }> {
    const input: Omit<CareContext, 'tryNumber'> = {
      edge: this.edge,
      binding: this.binding,
      message: msg,
    };
    if (this.channel !== undefined) input.channel = this.channel;
    if (data !== undefined) input.data = data;
    const result = await this.executor.execute(input, attempt, this.options);
    return { value: result.value as T, planB: result.planB };
  }
}

/**
 * Care of one step: static targets by channel, a `handle` care, or (for `route`) a lazy
 * resolver whose result is cached per channel (RS-67).
 */
export class StepCare implements StepCarePort {
  private readonly cache = new Map<string, TargetCare | null>();

  constructor(
    targets: ReadonlyMap<string, TargetCare>,
    readonly handle?: TargetCare,
    private readonly lazy?: (channel: string) => TargetCare | undefined,
  ) {
    for (const [channel, care] of targets) this.cache.set(channel, care);
  }

  target(channel: string): TargetCare | undefined {
    const cached = this.cache.get(channel);
    if (cached !== undefined) return cached ?? undefined;
    if (this.lazy === undefined) return undefined;
    // The lazy resolver throws for an unregistered channel, and nothing is cached then.
    const resolved = this.lazy(channel);
    this.cache.set(channel, resolved ?? null);
    return resolved;
  }
}

/** RS-61, RS-65: a shallow copy of the hop for one try, with the kept tries left stamped as 0. */
export function tryCopy(hop: IntegrationMessage, current: StepTry): IntegrationMessage {
  const headers: Record<string, unknown> = { ...hop.headers };
  if (current.triesLeftOut === 0) headers[TRIES_LEFT_MESSAGE_HEADER] = 0;
  return { payload: hop.payload, headers: headers as IntegrationMessage['headers'] };
}

/**
 * Sends one hop, under the target's care when it has one. The hop is built once by the caller
 * and every try sends an identical shallow copy (RS-61). Without care this is the 0.9.0 send.
 */
export async function sendHop(
  ctx: FlowStepContext,
  channel: string,
  hop: IntegrationMessage,
): Promise<void> {
  const target = ctx.care?.target(channel);
  if (target === undefined) {
    await ctx.registry.sendMessage(channel, hop);
    return;
  }
  await target.run(ctx.msg, (current) => ctx.registry.sendMessage(channel, tryCopy(hop, current)), {
    hop,
  });
}

/** RS-64: a reply built while plan B ran marks the waiting flow run. */
export function markIfPlanB(reply: IntegrationMessage): void {
  if (reply.headers[PLAN_B_HEADER] === true) CareScope.markPlanB();
}

/**
 * RS-62: one jump try opens its own `reply.<uuid>`, sends the hop with it, awaits the first
 * reply and, in `finally`, cancels the wait and unregisters the channel, so a late reply to an
 * earlier try is dropped.
 */
async function jumpTry(
  ctx: FlowStepContext,
  channel: string,
  hop: IntegrationMessage,
  current: StepTry,
): Promise<unknown> {
  const replyName = `reply.${newId()}`;
  const replyChannel = ctx.registry.create({ name: replyName, type: 'direct' });
  const waitMs = current.eachTryMs > 0 ? current.eachTryMs : LEGACY_JUMP_WAIT_MS;
  const wait = openFirstMessageWait(replyChannel, {
    timeoutMs: waitMs,
    name: channel,
    timeoutError: () => new JumpTimeoutError(channel, waitMs),
  });
  const cancel = (): void => wait.cancel();
  current.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const copy = tryCopy(hop, current);
    copy.headers.replyChannel = replyName;
    await ctx.registry.sendMessage(channel, copy);
    const reply = await wait.promise;
    markIfPlanB(reply);
    return reply.payload;
  } finally {
    current.signal?.removeEventListener('abort', cancel);
    wait.cancel();
    ctx.registry.unregister(replyName);
  }
}

/** RS-62: a jump target under its care; the hop is built once and reused by every try. */
export function jumpWithCare(
  ctx: FlowStepContext,
  target: TargetCarePort,
  channel: string,
): Promise<{ value: unknown; planB: boolean }> {
  const hop = nextHop(ctx.msg, { channel, component: `jump:${ctx.flowName}` }, { reply: 'none' });
  hop.headers[JUMP_REPLY_HEADER] = '1';
  return target.run(ctx.msg, (current) => jumpTry(ctx, channel, hop, current));
}
