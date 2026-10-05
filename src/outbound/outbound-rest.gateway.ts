import type { MessageHandlerFn, Unsubscribe } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import { createMessage, type IntegrationMessage, type MessageHeadersInit } from '../message';
import type { HopLogger } from '../trace/hop-logger';
import type { TraceContext } from '../trace/trace-context';
import { executeOutboundRest } from './outbound.call';
import { OutboundError } from './outbound.errors';
import { resolveOutboundRestPlan, type OutboundRestPlan } from './outbound.plan';
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
}

const globalFetch: OutboundFetch = (url, init) => globalThis.fetch(url, init);

function describeBinding(plan: OutboundRestPlan): OutboundRestBindingInfo {
  const info: OutboundRestBindingInfo = {
    name: plan.name,
    target: plan.description,
    line: `outbound rest: ${plan.name} -> ${plan.description}`,
  };
  if (plan.channel !== undefined) info.channel = plan.channel;
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

  constructor(private readonly deps: OutboundRestGatewayDeps = {}) {}

  /**
   * Declares a binding. Strategies are resolved and the configuration validated right away,
   * so a mistake fails here and not on the first message. The returned function removes the
   * binding and its channel subscription.
   */
  bind(binding: OutboundRestBinding): Unsubscribe {
    const plan = resolveOutboundRestPlan(binding, this.deps);
    if (this.plans.has(plan.name)) {
      throw new OutboundError(`outbound rest '${plan.name}' is already declared`);
    }
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
      plan = resolveOutboundRestPlan({ name: 'rest', ...options }, this.deps);
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
    return createMessage(input.payload, { ...inherited, ...input.headers });
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
