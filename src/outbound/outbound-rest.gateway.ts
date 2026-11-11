import type { MessageHandlerFn, Unsubscribe } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import { createMessage, type IntegrationMessage, type MessageHeadersInit } from '../message';
import type { HopLogger } from '../trace/hop-logger';
import type { TraceContext } from '../trace/trace-context';
import { TRIES_LEFT_MESSAGE_HEADER, CareScope } from '../resilience/retry-budget';
import { CareEngine } from '../resilience/runtime';
import { executeOutboundRest } from './outbound.call';
import { OutboundError } from './outbound.errors';
import { CareConfigError } from '../resilience/resilience.errors';
import { resolveOutboundRestPlan, type OutboundRestPlan } from './outbound.plan';
import {
  bindingRefsOf,
  OutboundPrivacy,
  type OutboundBindingRefs,
  type OutboundPrivacyDeps,
} from './outbound.privacy';
import type {
  OutboundFetch,
  OutboundMessageInput,
  OutboundProviderResolver,
  OutboundRestBinding,
  OutboundRestBindingInfo,
  OutboundRestCallOptions,
  OutboundRestDefaults,
  OutboundRestRequestOptions,
  OutboundRestResponse,
} from './outbound.types';

export interface OutboundRestGatewayDeps {
  /** Needed only by channel bindings. */
  registry?: ChannelRegistry;
  /** When given, a call without trace headers joins the ambient trace. */
  trace?: TraceContext;
  /** Module-wide defaults; bindings and ad-hoc options override them. */
  defaults?: OutboundRestDefaults;
  /** Resolves `{ useExisting }` strategies. */
  resolver?: OutboundProviderResolver;
  /** Hop logger; without it nothing is logged per call. */
  logger?: HopLogger;
  /** Default `globalThis.fetch`. */
  fetchFn?: OutboundFetch;
  /** Waits between retry attempts; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Care engine (the module's); a standalone gateway creates one on first use. */
  care?: CareEngine;
  /** Privacy engine (the module's) and channel levels; a standalone gateway uses the baseline. */
  privacy?: OutboundPrivacyDeps;
}

const globalFetch: OutboundFetch = (url, init) => globalThis.fetch(url, init);

function describeBinding(plan: OutboundRestPlan): OutboundRestBindingInfo {
  const summary = plan.care?.summary;
  const line = `outbound rest: ${plan.name} -> ${plan.description}`;
  const info: OutboundRestBindingInfo = {
    name: plan.name,
    target: plan.description,
    line: summary === undefined ? line : `${line} [${summary}]`,
  };
  if (plan.channel !== undefined) info.channel = plan.channel;
  if (summary !== undefined) info.care = summary;
  return info;
}

/**
 * Request/reply REST outbound port. `request` performs an HTTP call for a message and
 * resolves with the mapped response; `bind` declares a named target and, with a channel,
 * delivers every message sent to it and replies on `headers.replyChannel`.
 */
export class OutboundRestGateway {
  private readonly plans = new Map<string, OutboundRestPlan>();
  private readonly adHoc = new WeakMap<OutboundRestRequestOptions, OutboundRestPlan>();
  /** Binding privacy references of every plan, declared or ad hoc. */
  private readonly privacyRefs = new WeakMap<OutboundRestPlan, OutboundBindingRefs>();

  private standalone: CareEngine | undefined;
  private privacyState: OutboundPrivacy | undefined;

  constructor(private readonly deps: OutboundRestGatewayDeps = {}) {}

  private readonly runtime = (): CareEngine => {
    if (this.deps.care !== undefined) return this.deps.care;
    this.standalone ??= new CareEngine({}, { enabled: false });
    return this.standalone;
  };

  private privacy(): OutboundPrivacy {
    this.privacyState ??= new OutboundPrivacy(this.deps.privacy);
    return this.privacyState;
  }

  /** The binding's L4 references (module defaults first), kept beside its plan. */
  private refsOf(plan: OutboundRestPlan, binding: OutboundRestRequestOptions): OutboundBindingRefs {
    const own = { name: plan.name, ...binding };
    const refs = bindingRefsOf(own, this.deps.defaults?.privacy) ?? { name: plan.name };
    this.privacyRefs.set(plan, refs);
    return refs;
  }

  private planDeps(adHoc: boolean): Parameters<typeof resolveOutboundRestPlan>[1] {
    return { ...this.deps, care: this.runtime, adHoc };
  }

  /**
   * Declares a binding. Strategies are resolved and the configuration validated right away,
   * so a mistake fails here and not on the first message. The returned function removes the
   * binding and its channel subscription.
   */
  bind(binding: OutboundRestBinding): Unsubscribe {
    const plan = resolveOutboundRestPlan(binding, this.planDeps(false));
    this.assertPlanBChannel(plan);
    if (this.plans.has(plan.name)) {
      throw new OutboundError(`outbound rest '${plan.name}' is already declared`);
    }
    this.privacy().declare(this.refsOf(plan, binding));
    const unsubscribe = plan.channel === undefined ? undefined : this.subscribe(plan, plan.channel);
    this.plans.set(plan.name, plan);
    return () => {
      unsubscribe?.();
      this.plans.delete(plan.name);
    };
  }

  /** Declared bindings, in declaration order. */
  bindings(): OutboundRestBindingInfo[] {
    return [...this.plans.values()].map(describeBinding);
  }

  /**
   * Sends `message` to a declared binding (by name) or to ad-hoc options and resolves with
   * the reply: `{ status, headers, body }` unless a response mapper says otherwise. Failures
   * are `OutboundHttpError`, `OutboundNetworkError` or `OutboundTimeoutError`, or whatever the
   * error mapper returns.
   */
  async request<R = OutboundRestResponse>(
    target: string | OutboundRestRequestOptions,
    message: OutboundMessageInput,
    call: OutboundRestCallOptions = {},
  ): Promise<R> {
    const plan = typeof target === 'string' ? this.declared(target) : this.planOf(target);
    // SD-56: a call reference is checked before anything is built or sent.
    this.privacy().checkCall(plan, this.privacyRefs.get(plan) ?? { name: plan.name }, call.privacy);
    return (await this.run(plan, this.toMessage(message), call)) as R;
  }

  private declared(name: string): OutboundRestPlan {
    const plan = this.plans.get(name);
    if (plan === undefined) throw new OutboundError(`outbound rest '${name}' is not declared`);
    return plan;
  }

  /** Ad-hoc options are planned once per object: keep them in a constant to reuse the plan. */
  private planOf(options: OutboundRestRequestOptions): OutboundRestPlan {
    let plan = this.adHoc.get(options);
    if (plan === undefined) {
      plan = resolveOutboundRestPlan({ name: 'rest', ...options }, this.planDeps(true));
      this.privacy().checkAdHoc(this.refsOf(plan, options));
      this.adHoc.set(options, plan);
    }
    return plan;
  }

  private toMessage(input: OutboundMessageInput): IntegrationMessage {
    const ambient = this.deps.trace?.current();
    const inherited: MessageHeadersInit =
      ambient === undefined
        ? {}
        : {
            traceId: ambient.traceId,
            correlationId: ambient.correlationId,
            parentSpanId: ambient.spanId,
          };
    // RS-29: under forRoot({ care }) a call inherits the tries left of its scope.
    const triesLeft = this.deps.care?.enabled === true ? CareScope.current()?.triesLeft : undefined;
    if (triesLeft !== undefined) inherited[TRIES_LEFT_MESSAGE_HEADER] = triesLeft;
    return createMessage(input.payload, { ...inherited, ...input.headers });
  }

  /** A `planB.channel` must exist when the binding is declared (section 5.6). */
  private assertPlanBChannel(plan: OutboundRestPlan): void {
    const channel = plan.care?.plan.planB?.channel;
    const registry = this.deps.registry;
    if (channel === undefined || registry === undefined || registry.tryGet(channel) !== undefined)
      return;
    throw new CareConfigError(plan.name, 'planB.channel', `names an unknown channel '${channel}'`);
  }

  private run(
    plan: OutboundRestPlan,
    message: IntegrationMessage,
    call: OutboundRestCallOptions,
  ): Promise<unknown> {
    return executeOutboundRest(plan, message, call, {
      fetchFn: this.deps.fetchFn ?? globalFetch,
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
      ...(this.deps.sleep === undefined ? {} : { sleep: this.deps.sleep }),
    });
  }

  private subscribe(plan: OutboundRestPlan, channel: string): Unsubscribe {
    const { registry } = this.deps;
    if (registry === undefined) {
      throw new OutboundError(`outbound rest '${plan.name}': a channel binding needs a registry`);
    }
    const handler: MessageHandlerFn = async (msg) => {
      const reply = await this.run(plan, msg, {});
      const replyChannel = msg.headers.replyChannel;
      if (typeof replyChannel !== 'string' || replyChannel.length === 0) return;
      await registry.send(replyChannel, reply, {
        correlationId: msg.headers.correlationId,
        traceId: msg.headers.traceId,
        causationId: msg.headers.id,
        parentSpanId: msg.headers.spanId,
      });
    };
    return registry.get(channel).subscribe(handler);
  }
}
