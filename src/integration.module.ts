import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner, ModuleRef } from '@nestjs/core';
import { ACTIVATOR_METADATA, type ActivatorMetadata } from './decorators';
import { ChannelRegistry } from './channel-registry';
import { ChannelFactoryRegistry, type ChannelSpec } from './channel-factory';
import type { RabbitInboundMapping } from './inbound/inbound.explorer';
import type { AmqpLikeChannel } from './adapters/amqp-like.channel';
import { INBOUND_DEPS, type InboundInterceptorDeps } from './inbound/inbound.interceptor';
import type { InboundDefaults } from './inbound/inbound.types';
import { InboundExplorer } from './inbound/inbound.explorer';
import { carriedHeadersOf } from './inbound/inbound.carry';
import { discoverInbounds, type DiscoveredInbound } from './inbound/inbound.discovery';
import { serializeError } from './flow/flow-step';
import { FlowExecutor, type FlowDeps } from './flow/flow-executor';
import {
  FlowParameterResolver,
  type FlowResolution,
  type PrivacyPassResult,
  type ResolvedFlow,
  type TryingTarget,
} from './flow/flow-parameter-resolver';
import type { FlowDefinition } from './flow/integration-flow';
import { IdempotencyService } from './idempotency/idempotency.service';
import type { IdempotencyStore } from './idempotency/idempotency-store';
import { createMessage } from './message';
import { ReplyGateway } from './gateway/reply-gateway';
import { ChannelGraph, type GraphOutboundRef } from './graph/channel-graph';
import { ChannelGraphController } from './graph/channel-graph.controller';
import { TraceContext } from './trace/trace-context';
import {
  activatorCare,
  subscribeActivator,
  type ActivatorDeps,
} from './activator/activator-wrapper';
import { HopLogger, type IntegrationLoggingOptions } from './trace/hop-logger';
import { printEstelaBanner } from './trace/banner';
import { OutboundRestGateway } from './outbound/outbound-rest.gateway';
import {
  OUTBOUND_REST_METADATA,
  outboundRestBindingOf,
  type OutboundRestSpec,
} from './outbound/outbound.decorators';
import type { OutboundModuleOptions, OutboundRestBindingInfo } from './outbound/outbound.types';
import { CareControl } from './resilience/registry';
import { describeCare } from './resilience/resilience.plan';
import { inboundShedPlan } from './inbound/inbound.resilience';
import type { CareLogger, CareModuleOptions } from './resilience/resilience.types';
import { CareEngine } from './resilience/runtime';
import type { CareEvent } from './resilience/resilience.types';
import { PrivacyEngine, TrailOutput } from './sensitive/privacy-engine';
import type { PrivacyFinding } from './sensitive/privacy-errors';
import type { PrivacyModuleOptions } from './sensitive/privacy.types';
import type { PrivacyLevel, PrivacyScope } from './sensitive/policy-resolver';
import { envelopeBody, errorChannelText, textForLog } from './trace/trail';
import {
  bindingRefsOf,
  outboundPrivacyScope,
  outboundScopeName,
} from './outbound/outbound.privacy';
import {
  flowGraphPrivacy,
  flowPrivacyScopes,
  resolveFlowPrivacy,
  type FlowPrivacy,
} from './flow/flow-privacy';
import {
  activatorPrivacyScope,
  channelLevels,
  channelScopes,
  inboundPrivacyGuard,
  inboundPrivacyScope,
  nestPrivacyLogger,
} from './integration.privacy';

export const INTEGRATION_OPTIONS = 'INTEGRATION_OPTIONS';
/** DI token of the module's `CareEngine` (always present; enabled by forRoot({ care })). */
export const CARE_ENGINE = 'INTEGRATION_CARE_ENGINE';

function nestCareLogger(): CareLogger {
  const logger = new Logger('EstelaCare');
  return {
    log: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
    debug: (message) => logger.debug(message),
  };
}

export interface IntegrationIdempotencyOptions {
  enabled?: boolean;
  ttlMs?: number;
  store?: IdempotencyStore;
}

export interface IntegrationModuleOptions {
  channels: readonly ChannelSpec[];
  /** default 'error.channel' (auto-created pubsub, spec sec.5/sec.11). */
  errorChannel?: string;
  idempotency?: IntegrationIdempotencyOptions;
  /** Opt-in per-flow / per-hop logging (flow, channel, correlation). Default off. */
  logging?: IntegrationLoggingOptions;
  /** Optional AMQP port: when missing, declared mappings are reported with a warn, never a throw (spec sec.7.2). */
  rabbitChannel?: AmqpLikeChannel;
  rabbitMappings?: readonly RabbitInboundMapping[];
  /** Module-wide reply mapping and idempotency defaults of the inbound adapters. */
  inbound?: InboundDefaults;
  /** Outbound adapters: module-wide defaults and declared bindings (REST request/reply). */
  outbound?: OutboundModuleOptions;
  /**
   * Care (SPI-445): named profiles, tries left, events channel, metrics and key handling.
   * Without it, bindings that use `care` still run, but no tries left are read or sent.
   */
  care?: CareModuleOptions;
  /**
   * Privacy (SPI-433): what Estela writes about messages to the trail (logs, records, envelopes,
   * tap copies). Without it log lines apply the baseline (`secrets@1` and the hidden headers) and
   * records are as in 0.9.0; `false` turns privacy off (0.9.0 log text, three fixes kept).
   */
  privacy?: PrivacyModuleOptions | false;
}

export interface ResolvedIntegrationOptions extends IntegrationModuleOptions {
  errorChannel: string;
  flows: readonly FlowDefinition[];
}

/** Deps bundle of the inbound interceptor, including the module-wide inbound defaults. */
function inboundDepsProvider(): Provider {
  return {
    provide: INBOUND_DEPS,
    useFactory: (
      registry: ChannelRegistry,
      trace: TraceContext,
      idempotency: IdempotencyService,
      gateway: ReplyGateway,
      opts: ResolvedIntegrationOptions,
      moduleRef: ModuleRef,
      care: CareEngine,
      privacy: PrivacyEngine,
    ): InboundInterceptorDeps => ({
      registry,
      trace,
      idempotency,
      replyGateway: gateway,
      care,
      privacy,
      ensurePrivacy: inboundPrivacyGuard(privacy, opts.channels, opts.inbound),
      ...(opts.inbound !== undefined ? { defaults: opts.inbound } : {}),
      // Lazy and app-wide: consumer providers do not exist yet when this factory runs.
      resolver: { resolve: (token) => moduleRef.get(token, { strict: false }) },
    }),
    inject: [
      ChannelRegistry,
      TraceContext,
      IdempotencyService,
      ReplyGateway,
      INTEGRATION_OPTIONS,
      ModuleRef,
      CARE_ENGINE,
      PrivacyEngine,
    ],
  };
}

/** The engine of `forRoot({ privacy })`; boot lines only when privacy is configured. */
function privacyProvider(): Provider {
  return {
    provide: PrivacyEngine,
    useFactory: (opts: ResolvedIntegrationOptions): Promise<PrivacyEngine> => {
      const configured =
        opts.privacy !== undefined || opts.channels.some((spec) => spec.privacy !== undefined);
      // Findings are held for the boot resolver, which throws them with every other one (SD-55).
      return PrivacyEngine.forBoot(
        opts.privacy,
        channelScopes(opts.channels),
        configured ? nestPrivacyLogger() : undefined,
      );
    },
    inject: [INTEGRATION_OPTIONS],
  };
}

/** A declared REST binding as the graph shows it: target, care summary and privacy names. */
function graphOutboundRef(info: OutboundRestBindingInfo): GraphOutboundRef {
  const ref: GraphOutboundRef = { transport: 'rest', target: info.target };
  if (info.care !== undefined) ref.care = info.care;
  if (info.privacy !== undefined) ref.privacy = info.privacy;
  return ref;
}

function hopLoggerOf(
  options: IntegrationModuleOptions,
  privacy: PrivacyEngine,
): HopLogger | undefined {
  if (options.logging?.hops !== true) return undefined;
  return new HopLogger(options.logging.level ?? 'log', privacy);
}

/** Outbound REST port: module defaults, DI-resolved strategies and the module hop logging. */
function outboundRestProvider(): Provider {
  return {
    provide: OutboundRestGateway,
    useFactory: (
      registry: ChannelRegistry,
      trace: TraceContext,
      opts: ResolvedIntegrationOptions,
      moduleRef: ModuleRef,
      care: CareEngine,
      privacy: PrivacyEngine,
    ): OutboundRestGateway => {
      const defaults = opts.outbound?.rest?.defaults;
      const logger = hopLoggerOf(opts, privacy);
      return new OutboundRestGateway({
        registry,
        trace,
        care,
        privacy: { engine: privacy, channelLevels: (name) => channelLevels(opts.channels, name) },
        ...(defaults === undefined ? {} : { defaults }),
        ...(logger === undefined ? {} : { logger }),
        resolver: { resolve: (token) => moduleRef.get(token, { strict: false }) },
      });
    },
    inject: [
      ChannelRegistry,
      TraceContext,
      INTEGRATION_OPTIONS,
      ModuleRef,
      CARE_ENGINE,
      PrivacyEngine,
    ],
  };
}

/** The care engine, its request/reply for plan B channels and, when enabled, `CareControl`. */
function careProviders(options: IntegrationModuleOptions): Provider[] {
  const providers: Provider[] = [
    {
      provide: CARE_ENGINE,
      useFactory: (gateway: ReplyGateway): CareEngine => {
        const runtime = new CareEngine(options.care ?? {}, {
          enabled: options.care !== undefined,
          logger: nestCareLogger(),
        });
        runtime.setRequestReply((channel, payload, headers) =>
          gateway.sendAndReceive(channel, payload, headers),
        );
        return runtime;
      },
      inject: [ReplyGateway],
    },
  ];
  if (options.care !== undefined) {
    providers.push({
      provide: CareControl,
      useFactory: (runtime: CareEngine) => runtime.control,
      inject: [CARE_ENGINE],
    });
  }
  return providers;
}

@Module({})
export class IntegrationModule {
  static forRoot(
    options: IntegrationModuleOptions,
    flows: readonly FlowDefinition[] = [],
  ): DynamicModule {
    const resolved: ResolvedIntegrationOptions = {
      ...options,
      flows,
      errorChannel: options.errorChannel ?? 'error.channel',
    };
    const logger = new Logger('IntegrationModule');

    const providers: Provider[] = [
      TraceContext,
      ChannelGraph,
      { provide: INTEGRATION_OPTIONS, useValue: resolved },
      privacyProvider(),
      {
        provide: IdempotencyService,
        useFactory: (opts: ResolvedIntegrationOptions) =>
          new IdempotencyService(opts.idempotency ?? {}),
        inject: [INTEGRATION_OPTIONS],
      },
      {
        provide: ChannelRegistry,
        useFactory: (
          trace: TraceContext,
          opts: ResolvedIntegrationOptions,
          privacy: PrivacyEngine,
        ): ChannelRegistry => {
          // The error hook only runs on a channel send, long after `registry` is assigned.
          const registry: ChannelRegistry = new ChannelRegistry(
            {
              trace,
              onWarn: (message) => logger.warn(message),
              onError: (error, msg) => {
                const channel = msg.headers.history.at(-1)?.channel;
                const where = channel === undefined ? {} : { channel };
                const shown = envelopeBody(privacy, serializeError(error), where);
                const envelope = createMessage(
                  { error: shown, causedBy: msg.headers.id },
                  {
                    traceId: msg.headers.traceId,
                    correlationId: msg.headers.correlationId,
                    causationId: msg.headers.id,
                  },
                );
                void registry.sendMessage(opts.errorChannel, envelope).catch(() => undefined);
              },
            },
            new ChannelFactoryRegistry(),
          );
          return registry;
        },
        inject: [TraceContext, INTEGRATION_OPTIONS, PrivacyEngine],
      },
      {
        provide: ReplyGateway,
        useFactory: (registry: ChannelRegistry, trace: TraceContext) =>
          new ReplyGateway({ registry, trace }),
        inject: [ChannelRegistry, TraceContext],
      },
      ...careProviders(options),
      inboundDepsProvider(),
      outboundRestProvider(),
      {
        provide: InboundExplorer,
        useFactory: (
          registry: ChannelRegistry,
          trace: TraceContext,
          opts: ResolvedIntegrationOptions,
          privacy: PrivacyEngine,
        ) =>
          new InboundExplorer({
            registry,
            trace,
            ...(opts.rabbitChannel !== undefined ? { amqp: opts.rabbitChannel } : {}),
            ...(opts.rabbitMappings !== undefined ? { mappings: opts.rabbitMappings } : {}),
            log: (message) => logger.warn(message),
            onError: (error) => logger.error(textForLog(privacy, String(error))),
          }),
        inject: [ChannelRegistry, TraceContext, INTEGRATION_OPTIONS, PrivacyEngine],
      },
      IntegrationRuntime,
    ];

    return {
      global: true,
      module: IntegrationModule,
      imports: [DiscoveryModule],
      providers,
      controllers: [ChannelGraphController],
      exports: [
        ChannelRegistry,
        TraceContext,
        ReplyGateway,
        IdempotencyService,
        ChannelGraph,
        INBOUND_DEPS,
        InboundExplorer,
        OutboundRestGateway,
        CARE_ENGINE,
        PrivacyEngine,
        ...(options.care === undefined ? [] : [CareControl]),
      ],
    };
  }
}

@Injectable()
export class IntegrationRuntime implements OnApplicationShutdown {
  private readonly logger = new Logger('IntegrationRuntime');

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly registry: ChannelRegistry,
    private readonly trace: TraceContext,
    private readonly graph: ChannelGraph,
    private readonly idempotency: IdempotencyService,
    private readonly explorer: InboundExplorer,
    @Inject(INTEGRATION_OPTIONS)
    private readonly options: ResolvedIntegrationOptions,
    private readonly outbound: OutboundRestGateway,
    @Inject(CARE_ENGINE)
    private readonly care: CareEngine,
    private readonly privacy: PrivacyEngine,
  ) {}

  /**
   * Strict order (spec sec.11): channels -> flow parameters -> activators and outbounds ->
   * flows -> explorer. The flow parameter resolver (RS-67) runs before step 2 because activators
   * and outbound bindings take profile names, and it fails the boot before any subscription.
   */
  async onModuleInit(): Promise<void> {
    printEstelaBanner({ enabled: this.options.logging?.banner });

    // 1. error channel (auto) + channels declared
    if (this.registry.tryGet(this.options.errorChannel) === undefined) {
      this.registry.create({ name: this.options.errorChannel, type: 'pubsub' });
    }
    const errorChannel = this.registry.get(this.options.errorChannel);
    errorChannel.subscribe?.call(errorChannel, (msg) => {
      this.logger.error(`error.channel: ${errorChannelText(this.privacy, msg.payload)}`);
    });
    for (const spec of this.options.channels) {
      if (this.registry.tryGet(spec.name) === undefined) this.registry.create(spec);
    }
    this.care.declareChannels(this.options.channels);
    if (this.care.enabled) this.registry.inheritTriesLeft();
    this.openCareEvents();

    // 1b. flow parameters: every flow is built once and every care and privacy reference of
    // flows, activators and inbound endpoints is resolved before any subscription (RS-67, SD-55)
    const inbounds = this.discoverInbounds();
    let flowPrivacy = new Map<string, FlowPrivacy>();
    const resolution = new FlowParameterResolver(this.care, this.registry).resolve(
      this.options.flows,
      (flows) => {
        const pass = this.resolvePrivacy(flows, inbounds);
        flowPrivacy = pass.perFlow;
        return pass;
      },
    );

    // 2. activators (DiscoveryModule) and outbound bindings
    const tryingActivators = this.subscribeDiscoveredActivators();
    this.logDiscoveredInbounds(inbounds);
    const tryingOutbounds = this.bindOutbounds();
    this.warnStackedTries(resolution.tryingTargets, [...tryingActivators, ...tryingOutbounds]);

    // 3. flows: graph.recordFlow + attach (spec sec.11 step 3)
    this.attachFlows(resolution, flowPrivacy);

    // 4. explorer (rabbit), last
    await this.explorer.onModuleInit();
  }

  /**
   * SD-37, SD-55: the privacy pass of the boot resolver. Every privacy scope found at boot
   * compiles before any subscription; the findings of the module compile, the scopes and the taps
   * are returned together. Returns the trail writers of each flow too.
   */
  private resolvePrivacy(
    flows: readonly ResolvedFlow[],
    inbounds: readonly DiscoveredInbound[],
  ): PrivacyPassResult & { perFlow: Map<string, FlowPrivacy> } {
    const channels = this.options.channels;
    const held = this.privacy.bootFindings();
    const findings: PrivacyFinding[] = [...held.findings];
    const problems: string[] = [...held.problems];
    const perFlow = new Map<string, FlowPrivacy>();
    const scopes: Record<string, PrivacyScope> = {};
    for (const { instance, methodName, metadata } of this.annotatedMethods<ActivatorMetadata>(
      ACTIVATOR_METADATA,
    )) {
      const name = `${instance.constructor.name}.${methodName}`;
      scopes[`activator:${name}`] = activatorPrivacyScope(channels, name, metadata);
    }
    for (const inbound of inbounds) {
      const scope = inboundPrivacyScope(channels, inbound.spec, this.options.inbound);
      scopes[`inbound:${inbound.spec.channel}`] = scope;
    }
    Object.assign(scopes, this.outboundPrivacyScopes());
    const levelsOf = (name: string): PrivacyLevel[] => channelLevels(channels, name);
    const flowScopes: Record<string, PrivacyScope> = {};
    for (const flow of flows) {
      Object.assign(flowScopes, flowPrivacyScopes(flow.name, flow.built, levelsOf));
    }
    const log = nestPrivacyLogger();
    // Flow and step scopes print their boot lines only under explicit privacy (SD-60).
    for (const added of [
      this.privacy.addScopes(scopes),
      this.privacy.addScopes(flowScopes, { logger: log }),
    ]) {
      findings.push(...added.findings);
      problems.push(...added.problems);
    }
    if (findings.length > 0) return { findings, problems, perFlow };
    const env = {
      levelsOf,
      isRegistered: (name: string) => this.registry.tryGet(name) !== undefined,
      logger: log,
    };
    for (const flow of flows) {
      const resolved = resolveFlowPrivacy(this.privacy, flow.name, flow.built, env);
      findings.push(...resolved.findings);
      problems.push(...resolved.problems);
      for (const note of resolved.notes) log.warn(note);
      if (resolved.privacy !== undefined) perFlow.set(flow.name, resolved.privacy);
    }
    return { findings, problems, perFlow };
  }

  /** One scope per declared outbound REST binding, options first, then `@OutboundRest` (SD-64). */
  private outboundPrivacyScopes(): Record<string, PrivacyScope> {
    const rest = this.options.outbound?.rest;
    const specs: OutboundRestSpec[] = [...(rest?.bindings ?? [])];
    for (const { metadata } of this.annotatedMethods<OutboundRestSpec>(OUTBOUND_REST_METADATA)) {
      specs.push(metadata);
    }
    const levelsOf = (name: string): PrivacyLevel[] => channelLevels(this.options.channels, name);
    const scopes: Record<string, PrivacyScope> = {};
    for (const spec of specs) {
      const refs = bindingRefsOf(spec, rest?.defaults?.privacy);
      if (refs !== undefined)
        scopes[outboundScopeName(refs.name)] = outboundPrivacyScope(refs, levelsOf);
    }
    return scopes;
  }

  private attachFlows(resolution: FlowResolution, privacy: Map<string, FlowPrivacy>): void {
    for (const [channel, care] of resolution.channelCare) {
      this.graph.recordChannelCare(channel, care);
    }
    this.graph.recordCareProfiles(Object.keys(this.care.options.profiles ?? {}));
    this.recordPrivacyNames();
    const levelsOf = (name: string): PrivacyLevel[] => channelLevels(this.options.channels, name);
    for (const flow of resolution.flows) {
      const named = flowGraphPrivacy(this.privacy, flow.name, flow.built, flow.described, levelsOf);
      this.graph.recordFlow(flow.name, flow.built, named.steps, named.options);
      const executorDeps: FlowDeps = {
        registry: this.registry,
        trace: this.trace,
        errorChannel: this.options.errorChannel,
        idempotency: this.idempotency,
        care: this.care,
        stepCare: flow.stepCare,
      };
      const flowPrivacy = privacy.get(flow.name);
      if (flowPrivacy !== undefined) executorDeps.privacy = flowPrivacy;
      if (this.options.idempotency?.ttlMs !== undefined) {
        executorDeps.idempotencyTtlMs = this.options.idempotency.ttlMs;
      }
      const flowLog = this.hopLogger();
      if (flowLog !== undefined) executorDeps.logger = flowLog;
      new FlowExecutor(flow.name, flow.built, executorDeps).attachTo(this.registry);
    }
  }

  /** SD-59: privacy names of declared channels and the module's profile names in the graph. */
  private recordPrivacyNames(): void {
    const channels = this.options.channels;
    for (const spec of channels) {
      const names = this.privacy.graphNames({ levels: channelLevels(channels, spec.name) });
      if (names !== undefined) this.graph.recordChannelPrivacy(spec.name, names);
    }
    const privacy = this.options.privacy;
    if (privacy !== undefined && privacy !== false) {
      this.graph.recordPrivacyProfiles(Object.keys(privacy.profiles ?? {}));
    }
  }

  /**
   * RS-56, RS-60: one TRIES_STACKED warning per flow target whose extra tries send into a
   * channel whose activator or outbound binding also tries again. Tries left bound the product.
   */
  private warnStackedTries(
    targets: readonly TryingTarget[],
    endpoints: readonly { channel: string; subject: string }[],
  ): void {
    for (const target of targets) {
      for (const endpoint of endpoints.filter((e) => e.channel === target.channel)) {
        this.care.observer.logger.warn(
          `TRIES_STACKED: ${target.subject} tries again into channel '${target.channel}', and ${endpoint.subject} tries again too; tries left bound the total`,
        );
      }
    }
  }

  /** RS-40: pubsub events channel, published fire-and-forget. */
  private openCareEvents(): void {
    const channel = this.care.eventsChannel;
    if (channel === undefined) return;
    if (this.registry.tryGet(channel) === undefined)
      this.registry.create({ name: channel, type: 'pubsub' });
    this.care.setPublisher((event) => this.registry.send(channel, this.shownEvent(event)));
  }

  /** Care events hold names and numbers only; an app `keyLabel` is still trail text (SD-62). */
  private shownEvent(event: CareEvent): CareEvent {
    if (event.keyLabel === undefined || !this.privacy.reaches({})) return event;
    const keyLabel = this.privacy.textForTrail(event.keyLabel, { output: TrailOutput.WireTap });
    return { ...event, keyLabel };
  }

  /** Shutdown: background flow tries stop, then queues drain (plan sec.8.6/sec.9.10). */
  async onApplicationShutdown(): Promise<void> {
    this.care.shutdown();
    for (const channel of this.registry.list()) {
      if (channel.kind === 'queue') await channel.close?.();
    }
  }

  // Reflection over metadata written by our own decorators.
  /* eslint-disable @typescript-eslint/no-unsafe-assignment */
  private *annotatedMethods<T>(
    metadataKey: string,
  ): Generator<{ instance: object; methodName: string; metadata: T }> {
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (instance === null || typeof instance !== 'object') continue;
      let proto: object | null = Object.getPrototypeOf(instance);
      while (proto !== null && proto !== Object.prototype) {
        for (const methodName of this.metadataScanner.getAllMethodNames(proto)) {
          const metadata = Reflect.getMetadata(metadataKey, proto, methodName) as T | undefined;
          if (metadata !== undefined) yield { instance, methodName, metadata };
        }
        proto = Object.getPrototypeOf(proto);
      }
    }
  }
  /* eslint-enable @typescript-eslint/no-unsafe-assignment */

  /** Subscribes every activator; returns those whose care tries again (TRIES_STACKED input). */
  private subscribeDiscoveredActivators(): { channel: string; subject: string }[] {
    const trying: { channel: string; subject: string }[] = [];
    const found = this.annotatedMethods<ActivatorMetadata>(ACTIVATOR_METADATA);
    for (const { instance, methodName, metadata } of found) {
      const binding = { instance, methodName, metadata };
      const deps = this.activatorDeps();
      subscribeActivator(binding, deps);
      const { summary, executor } = activatorCare(binding, deps);
      if ((executor?.plan.tries?.max ?? 1) > 1) {
        trying.push({
          channel: metadata.channel,
          subject: `activator ${instance.constructor.name}.${methodName}`,
        });
      }
      const label = `${instance.constructor.name}.${methodName}`;
      this.graph.recordActivator(
        metadata.channel,
        summary === undefined ? label : `${label} [${summary}]`,
      );
      this.logger.log(
        `activator: ${instance.constructor.name}.${methodName} -> ${metadata.channel}`,
      );
    }
    return trying;
  }

  /**
   * Declared outbound bindings (module options, then `@OutboundRest` methods): bound, logged
   * with one line each and recorded in the graph. A misconfigured binding fails the boot.
   */
  private bindOutbounds(): { channel: string; subject: string }[] {
    const trying: { channel: string; subject: string }[] = [];
    for (const binding of this.options.outbound?.rest?.bindings ?? []) {
      this.outbound.bind(binding);
    }
    const annotated = this.annotatedMethods<OutboundRestSpec>(OUTBOUND_REST_METADATA);
    for (const { instance, methodName, metadata } of annotated) {
      this.outbound.bind(outboundRestBindingOf(instance, methodName, metadata));
    }
    for (const info of this.outbound.bindings()) {
      if (info.channel !== undefined) {
        this.graph.recordOutbound(info.channel, graphOutboundRef(info));
      }
      // The binding summary (RS-42) names `tries xN` only when more than one try is allowed.
      if (info.channel !== undefined && /\btries x\d+/.test(info.care ?? '')) {
        trying.push({ channel: info.channel, subject: `outbound rest '${info.name}'` });
      }
      this.logger.log(info.line);
    }
    return trying;
  }

  /** The annotated entry points; a discovery failure never breaks boot (S15 line hidden). */
  private discoverInbounds(): DiscoveredInbound[] {
    const skipped = (error: unknown): void => {
      this.logger.warn(`inbound discovery skipped: ${textForLog(this.privacy, String(error))}`);
    };
    try {
      const sources = [...this.discovery.getControllers(), ...this.discovery.getProviders()];
      return discoverInbounds(sources, {
        methodNames: (proto) => this.metadataScanner.getAllMethodNames(proto),
        onError: skipped,
      });
    } catch (error) {
      skipped(error);
      return [];
    }
  }

  /** Boot visibility of the annotated entry points. */
  private logDiscoveredInbounds(inbounds: readonly DiscoveredInbound[]): void {
    for (const inbound of inbounds) {
      // RS-03, RS-37: invalid inbound care or carryHeaders fails the boot, outside the guard.
      carriedHeadersOf(inbound.spec);
      const plan = inboundShedPlan(inbound.spec, this.options.inbound, this.care);
      const summary = plan === undefined ? undefined : describeCare(plan);
      const scope = inboundPrivacyScope(this.options.channels, inbound.spec, this.options.inbound);
      this.graph.recordInbound(inbound.spec, summary, this.privacy.graphNames(scope));
      this.logger.log(summary === undefined ? inbound.line : `${inbound.line} [${summary}]`);
    }
  }

  private hopLoggerInstance: HopLogger | undefined;

  private hopLogger(): HopLogger | undefined {
    this.hopLoggerInstance ??= hopLoggerOf(this.options, this.privacy);
    return this.hopLoggerInstance;
  }

  private activatorDeps(): ActivatorDeps {
    const deps: ActivatorDeps = {
      registry: this.registry,
      trace: this.trace,
      errorChannel: this.options.errorChannel,
      idempotency: this.idempotency,
      care: this.care,
      privacy: this.privacy,
    };
    if (this.options.idempotency?.ttlMs !== undefined) {
      deps.idempotencyTtlMs = this.options.idempotency.ttlMs;
    }
    const log = this.hopLogger();
    if (log !== undefined) deps.logger = log;
    return deps;
  }
}
