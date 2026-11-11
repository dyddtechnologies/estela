import { randomInt } from 'node:crypto';
import { CareExecutor, type CareDeps, type CareEdgeAdapter } from './executor';
import { CareObserver } from './observability';
import { RuntimeCareControl } from './registry';
import { CareConfigError } from './resilience.errors';
import {
  resolveCarePlan,
  validateProfiles,
  type CarePlan,
  type ResolvePlanOptions,
} from './resilience.plan';
import { TRIES_LEFT_HEADER } from './retry-budget';
import type {
  CareClock,
  CareContext,
  CareEdge,
  CareEvent,
  CareLogger,
  CareModuleOptions,
  CareRefOf,
} from './resilience.types';
import { systemCareClock } from './timeout';

export const DEFAULT_CARE_EVENTS_CHANNEL = 'estela.care.events';

export type RequestReplyFn = (
  channel: string,
  payload: unknown,
  headers: Record<string, unknown>,
) => Promise<unknown>;

export interface CareEngineInit {
  /** True under forRoot({ care }): tries left, events channel and control are on. */
  enabled?: boolean;
  logger?: CareLogger;
}

/** RS-53, RS-54: profiles and reserved defaults fail the boot before any subject resolves them. */
function validateModuleOptions(options: CareModuleOptions): void {
  validateProfiles(options.profiles);
  if (options.defaults?.inbound !== undefined) {
    throw new CareConfigError(
      'care',
      'defaults.inbound',
      'is not allowed; inbound care comes from InboundDefaults.care',
    );
  }
}

/**
 * Module-wide care engine: options, named profiles, clock, observability and the control over
 * its executors. The module creates one; standalone gateways and saga runners create their own.
 */
export class CareEngine {
  readonly enabled: boolean;
  readonly clock: CareClock;
  readonly random: (maxExclusive: number) => number;
  readonly observer: CareObserver;
  readonly control = new RuntimeCareControl();
  private publisher: ((event: CareEvent) => Promise<void>) | undefined;
  private requestReply: RequestReplyFn | undefined;
  private readonly channelCare = new Map<string, CareRefOf>();
  private readonly stopping = new AbortController();
  private careSeen = false;

  constructor(
    readonly options: CareModuleOptions = {},
    init: CareEngineInit = {},
  ) {
    this.enabled = init.enabled ?? true;
    validateModuleOptions(options);
    this.clock = options.clock ?? systemCareClock;
    this.random = options.random ?? ((max) => randomInt(max));
    const logger = options.logger ?? init.logger;
    this.observer = new CareObserver({
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
    return channel ?? DEFAULT_CARE_EVENTS_CHANNEL;
  }

  setPublisher(publish: (event: CareEvent) => Promise<void>): void {
    this.publisher = publish;
  }

  /** Request/reply used by `planB.channel` (the module wires its ReplyGateway). */
  setRequestReply(requestReply: RequestReplyFn): void {
    this.requestReply = requestReply;
  }

  /** Runs a `planB.channel` as request/reply with the payload and trace of the message. */
  channelPlanB(): (channel: string, ctx: CareContext) => Promise<unknown> {
    return (channel, ctx) => {
      const requestReply = this.requestReply;
      if (requestReply === undefined) {
        return Promise.reject(new Error('planB.channel needs a reply gateway'));
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

  /** RS-56: records the L2 references of the declared channels (`ChannelSpec.care`). */
  declareChannels(specs: readonly { name: string; care?: CareRefOf }[]): void {
    for (const spec of specs) {
      if (spec.care === undefined) continue;
      this.channelCare.set(spec.name, spec.care);
      this.careSeen = true;
    }
  }

  /**
   * True once the module has any care configuration: `forRoot({ care })`, or a `care` reference
   * resolved for a channel, flow, step, activator, inbound endpoint or outbound binding. While it
   * is false, flows, activators and inbound endpoints keep the 0.9.0 behaviour exactly: no message
   * scope, no plan B mark and every header copied as is (RS-70).
   */
  get configured(): boolean {
    return this.enabled || this.careSeen;
  }

  /** L2 reference of a channel, or undefined when its spec sets none. */
  channelCareRef(channel: string): CareRefOf | undefined {
    return this.channelCare.get(channel);
  }

  /** Channels declared with a care reference, in declaration order. */
  get channelsWithCare(): readonly string[] {
    return [...this.channelCare.keys()];
  }

  /** Aborted when the application shuts down; background flow tries stop (RS-62). */
  get shutdownSignal(): AbortSignal {
    return this.stopping.signal;
  }

  shutdown(): void {
    this.stopping.abort();
  }

  /** Header carrying the tries left on the wire (RS-29). */
  get triesLeftHeader(): string {
    return this.options.triesLeft?.header ?? TRIES_LEFT_HEADER;
  }

  /** Resolves and validates a plan with the named profiles (RS-03, RS-43, RS-51). */
  plan(
    binding: string,
    layers: readonly (CareRefOf | undefined)[],
    edge: CareEdge,
    options: Omit<ResolvePlanOptions, 'profiles'> = {},
  ): CarePlan {
    if (layers.some((layer) => layer !== undefined)) this.careSeen = true;
    const plan = resolveCarePlan(binding, layers, edge, {
      ...options,
      ...(this.options.profiles === undefined ? {} : { profiles: this.options.profiles }),
    });
    this.assertHashedKeys(plan);
    for (const warning of plan.warnings) this.observer.logger.warn(warning);
    return plan;
  }

  /** A tracked executor for `plan` (one per edge and binding). */
  executor<T>(
    plan: CarePlan,
    adapter: CareEdgeAdapter,
    extra: Pick<CareDeps, 'planBChannel' | 'planBLeave' | 'defaultKey' | 'shutdown'> = {},
  ): CareExecutor<T> {
    const executor = new CareExecutor<T>(plan, adapter, { ...this.deps(), ...extra });
    this.control.track(executor);
    return executor;
  }

  deps(): CareDeps {
    const deps: CareDeps = {
      clock: this.clock,
      random: this.random,
      observer: this.observer,
      triesLeft: {
        enabled: this.enabled,
        ...(this.options.triesLeft?.initial === undefined
          ? {}
          : { initial: this.options.triesLeft.initial }),
      },
      sharedStateWaitMs: this.options.sharedStateWaitMs ?? 100,
      sharedStateCheckMs: this.options.sharedStateCheckMs ?? 5000,
    };
    if (this.options.keyLabel !== undefined) deps.keyLabel = this.options.keyLabel;
    if (this.options.keyHasher !== undefined) deps.keyHasher = this.options.keyHasher;
    return deps;
  }

  /** RS-43: a custom key with shared state needs a module keyHasher; no unsalted alternative. */
  private assertHashedKeys(plan: CarePlan): void {
    if (this.options.keyHasher !== undefined) return;
    if (plan.valve?.key !== undefined && plan.valve.state !== undefined) {
      throw new CareConfigError(
        plan.binding,
        'valve.state',
        'needs a module keyHasher with a custom key',
      );
    }
    if (plan.pace?.key !== undefined && plan.pace.state !== undefined) {
      throw new CareConfigError(
        plan.binding,
        'pace.state',
        'needs a module keyHasher with a custom key',
      );
    }
  }
}
