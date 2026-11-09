import { randomInt } from 'node:crypto';
import { ResilienceExecutor, type ResilienceDeps, type ResilienceEdgeAdapter } from './executor';
import { ResilienceObserver } from './observability';
import { RuntimeResilienceRegistry } from './registry';
import { ResilienceDefinitionError } from './resilience.errors';
import {
  resolveResiliencePlan,
  validateProfiles,
  type ResiliencePlan,
  type ResolvePlanOptions,
} from './resilience.plan';
import { RETRY_BUDGET_HEADER } from './retry-budget';
import type {
  ResilienceClock,
  ResilienceContext,
  ResilienceEdgeKind,
  ResilienceEvent,
  ResilienceLogger,
  ResilienceModuleOptions,
  ResiliencePolicyRef,
} from './resilience.types';
import { systemResilienceClock } from './timeout';

export const DEFAULT_RESILIENCE_EVENTS_CHANNEL = 'estela.resilience.events';

export type RequestReplyFn = (
  channel: string,
  payload: unknown,
  headers: Record<string, unknown>,
) => Promise<unknown>;

export interface ResilienceRuntimeInit {
  /** True under forRoot({ resilience }): retry budget, events channel and registry are on. */
  enabled?: boolean;
  logger?: ResilienceLogger;
}

/** RS-53, RS-54: profiles and reserved defaults fail the boot before any subject resolves them. */
function validateModuleOptions(options: ResilienceModuleOptions): void {
  validateProfiles(options.policies);
  if (options.defaults?.inbound !== undefined) {
    throw new ResilienceDefinitionError(
      'resilience',
      'defaults.inbound',
      'is not allowed; inbound load shedding comes from InboundDefaults.resilience',
    );
  }
}

/**
 * Module-wide resilience state: options, named policies, clock, observability and the registry
 * of executors. The module creates one; standalone gateways and saga runners create their own.
 */
export class ResilienceRuntime {
  readonly enabled: boolean;
  readonly clock: ResilienceClock;
  readonly random: (maxExclusive: number) => number;
  readonly observer: ResilienceObserver;
  readonly registry = new RuntimeResilienceRegistry();
  private publisher: ((event: ResilienceEvent) => Promise<void>) | undefined;
  private requestReply: RequestReplyFn | undefined;
  private readonly channelPolicies = new Map<string, ResiliencePolicyRef>();
  private readonly stopping = new AbortController();

  constructor(
    readonly options: ResilienceModuleOptions = {},
    init: ResilienceRuntimeInit = {},
  ) {
    this.enabled = init.enabled ?? true;
    validateModuleOptions(options);
    this.clock = options.clock ?? systemResilienceClock;
    this.random = options.random ?? ((max) => randomInt(max));
    const logger = options.logger ?? init.logger;
    this.observer = new ResilienceObserver({
      clock: this.clock,
      ...(logger === undefined ? {} : { logger }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      ...(options.events?.onEvent === undefined ? {} : { onEvent: options.events.onEvent }),
      publish: (event) => this.publisher?.(event) ?? Promise.resolve(),
    });
  }

  /** Name of the events channel, or undefined when off (RS-40). */
  get eventsChannel(): string | undefined {
    if (!this.enabled) return undefined;
    const channel = this.options.events?.channel;
    if (channel === false) return undefined;
    return channel ?? DEFAULT_RESILIENCE_EVENTS_CHANNEL;
  }

  setPublisher(publish: (event: ResilienceEvent) => Promise<void>): void {
    this.publisher = publish;
  }

  /** Request/reply used by `fallback.channel` (the module wires its ReplyGateway). */
  setRequestReply(requestReply: RequestReplyFn): void {
    this.requestReply = requestReply;
  }

  /** Runs a `fallback.channel` as request/reply with the payload and trace of the message. */
  channelFallback(): (channel: string, ctx: ResilienceContext) => Promise<unknown> {
    return (channel, ctx) => {
      const requestReply = this.requestReply;
      if (requestReply === undefined) {
        return Promise.reject(new Error('fallback.channel needs a reply gateway'));
      }
      const headers = ctx.message?.headers;
      const init: Record<string, unknown> =
        headers === undefined
          ? {}
          : {
              traceId: headers.traceId,
              correlationId: headers.correlationId,
              causationId: headers.id,
            };
      return requestReply(channel, ctx.message?.payload, init);
    };
  }

  /** RS-56: records the L2 references of the declared channels (`ChannelSpec.resilience`). */
  declareChannels(specs: readonly { name: string; resilience?: ResiliencePolicyRef }[]): void {
    for (const spec of specs) {
      if (spec.resilience !== undefined) this.channelPolicies.set(spec.name, spec.resilience);
    }
  }

  /** L2 reference of a channel, or undefined when its spec sets none. */
  channelPolicy(channel: string): ResiliencePolicyRef | undefined {
    return this.channelPolicies.get(channel);
  }

  /** Channels declared with a resilience reference, in declaration order. */
  get channelsWithPolicy(): readonly string[] {
    return [...this.channelPolicies.keys()];
  }

  /** Aborted when the application shuts down; background flow attempts stop (RS-62). */
  get shutdownSignal(): AbortSignal {
    return this.stopping.signal;
  }

  shutdown(): void {
    this.stopping.abort();
  }

  /** Header carrying the retry budget on the wire (RS-29). */
  get budgetHeader(): string {
    return this.options.retryBudget?.header ?? RETRY_BUDGET_HEADER;
  }

  /** Resolves and validates a plan with the named policies (RS-03, RS-43, RS-51). */
  plan(
    binding: string,
    layers: readonly (ResiliencePolicyRef | undefined)[],
    edge: ResilienceEdgeKind,
    options: Omit<ResolvePlanOptions, 'policies'> = {},
  ): ResiliencePlan {
    const plan = resolveResiliencePlan(binding, layers, edge, {
      ...options,
      ...(this.options.policies === undefined ? {} : { policies: this.options.policies }),
    });
    this.assertHashedKeys(plan);
    for (const warning of plan.warnings) this.observer.logger.warn(warning);
    return plan;
  }

  /** A tracked executor for `plan` (one per edge and binding). */
  executor<T>(
    plan: ResiliencePlan,
    adapter: ResilienceEdgeAdapter,
    extra: Pick<ResilienceDeps, 'fallbackChannel' | 'defaultKey' | 'shutdown'> = {},
  ): ResilienceExecutor<T> {
    const executor = new ResilienceExecutor<T>(plan, adapter, { ...this.deps(), ...extra });
    this.registry.track(executor);
    return executor;
  }

  deps(): ResilienceDeps {
    const deps: ResilienceDeps = {
      clock: this.clock,
      random: this.random,
      observer: this.observer,
      budget: {
        enabled: this.enabled,
        ...(this.options.retryBudget?.initial === undefined
          ? {}
          : { initial: this.options.retryBudget.initial }),
      },
      stateTimeoutMs: this.options.stateTimeoutMs ?? 100,
      stateProbeMs: this.options.stateProbeMs ?? 5000,
    };
    if (this.options.keyLabel !== undefined) deps.keyLabel = this.options.keyLabel;
    if (this.options.keyHasher !== undefined) deps.keyHasher = this.options.keyHasher;
    return deps;
  }

  /** RS-43: a custom key with shared state needs a module keyHasher; no unsalted fallback. */
  private assertHashedKeys(plan: ResiliencePlan): void {
    if (this.options.keyHasher !== undefined) return;
    if (plan.circuitBreaker?.key !== undefined && plan.circuitBreaker.state !== undefined) {
      throw new ResilienceDefinitionError(
        plan.binding,
        'circuitBreaker.state',
        'needs a module keyHasher with a custom key',
      );
    }
    if (plan.rateLimit?.key !== undefined && plan.rateLimit.state !== undefined) {
      throw new ResilienceDefinitionError(
        plan.binding,
        'rateLimit.state',
        'needs a module keyHasher with a custom key',
      );
    }
  }
}
