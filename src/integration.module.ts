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
import { discoverInbounds } from './inbound/inbound.discovery';
import { serializeError } from './flow/flow-step';
import { FlowExecutor, type FlowDeps } from './flow/flow-executor';
import {
  FlowParameterResolver,
  type FlowResolution,
  type TryingTarget,
} from './flow/flow-parameter-resolver';
import type { FlowDefinition } from './flow/integration-flow';
import { IdempotencyService } from './idempotency/idempotency.service';
import type { IdempotencyStore } from './idempotency/idempotency-store';
import { createMessage } from './message';
import { ReplyGateway } from './gateway/reply-gateway';
import { ChannelGraph } from './graph/channel-graph';
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
import type { OutboundModuleOptions } from './outbound/outbound.types';
import { CareControl } from './resilience/registry';
import { describeCare } from './resilience/resilience.plan';
import { inboundShedPlan } from './inbound/inbound.resilience';
import type { CareLogger, CareModuleOptions } from './resilience/resilience.types';
import { CareEngine } from './resilience/runtime';

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
    ): InboundInterceptorDeps => ({
      registry,
      trace,
      idempotency,
      replyGateway: gateway,
      care,
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
    ],
  };
}

function hopLoggerOf(options: IntegrationModuleOptions): HopLogger | undefined {
  if (options.logging?.hops !== true) return undefined;
  return new HopLogger(options.logging.level ?? 'log');
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
    ): OutboundRestGateway => {
      const defaults = opts.outbound?.rest?.defaults;
      const logger = hopLoggerOf(opts);
      return new OutboundRestGateway({
        registry,
        trace,
        care,
        ...(defaults === undefined ? {} : { defaults }),
        ...(logger === undefined ? {} : { logger }),
        resolver: { resolve: (token) => moduleRef.get(token, { strict: false }) },
      });
    },
    inject: [ChannelRegistry, TraceContext, INTEGRATION_OPTIONS, ModuleRef, CARE_ENGINE],
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
      {
        provide: IdempotencyService,
        useFactory: (opts: ResolvedIntegrationOptions) =>
          new IdempotencyService(opts.idempotency ?? {}),
        inject: [INTEGRATION_OPTIONS],
      },
      {
        provide: ChannelRegistry,
        useFactory: (trace: TraceContext, opts: ResolvedIntegrationOptions): ChannelRegistry => {
          // The error hook only runs on a channel send, long after `registry` is assigned.
          const registry: ChannelRegistry = new ChannelRegistry(
            {
              trace,
              onWarn: (message) => logger.warn(message),
              onError: (error, msg) => {
                const envelope = createMessage(
                  { error: serializeError(error), causedBy: msg.headers.id },
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
        inject: [TraceContext, INTEGRATION_OPTIONS],
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
        ) =>
          new InboundExplorer({
            registry,
            trace,
            ...(opts.rabbitChannel !== undefined ? { amqp: opts.rabbitChannel } : {}),
            ...(opts.rabbitMappings !== undefined ? { mappings: opts.rabbitMappings } : {}),
            log: (message) => logger.warn(message),
            onError: (error) => logger.error(String(error)),
          }),
        inject: [ChannelRegistry, TraceContext, INTEGRATION_OPTIONS],
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
      this.logger.error(`error.channel: ${JSON.stringify(msg.payload)}`);
    });
    for (const spec of this.options.channels) {
      if (this.registry.tryGet(spec.name) === undefined) this.registry.create(spec);
    }
    this.care.declareChannels(this.options.channels);
    if (this.care.enabled) this.registry.inheritTriesLeft();
    this.openCareEvents();

    // 1b. flow parameters: every flow is built once and every reference resolved (RS-67)
    const resolution = new FlowParameterResolver(this.care, this.registry).resolve(
      this.options.flows,
    );

    // 2. activators (DiscoveryModule) and outbound bindings
    const tryingActivators = this.subscribeDiscoveredActivators();
    this.logDiscoveredInbounds();
    const tryingOutbounds = this.bindOutbounds();
    this.warnStackedTries(resolution.tryingTargets, [...tryingActivators, ...tryingOutbounds]);

    // 3. flows: graph.recordFlow + attach (spec sec.11 step 3)
    this.attachFlows(resolution);

    // 4. explorer (rabbit), last
    await this.explorer.onModuleInit();
  }

  private attachFlows(resolution: FlowResolution): void {
    for (const [channel, care] of resolution.channelCare) {
      this.graph.recordChannelCare(channel, care);
    }
    this.graph.recordCareProfiles(Object.keys(this.care.options.profiles ?? {}));
    for (const flow of resolution.flows) {
      this.graph.recordFlow(flow.name, flow.built, flow.described);
      const executorDeps: FlowDeps = {
        registry: this.registry,
        trace: this.trace,
        errorChannel: this.options.errorChannel,
        idempotency: this.idempotency,
        care: this.care,
        stepCare: flow.stepCare,
      };
      if (this.options.idempotency?.ttlMs !== undefined) {
        executorDeps.idempotencyTtlMs = this.options.idempotency.ttlMs;
      }
      const flowLog = this.hopLogger();
      if (flowLog !== undefined) executorDeps.logger = flowLog;
      new FlowExecutor(flow.name, flow.built, executorDeps).attachTo(this.registry);
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
    this.care.setPublisher((event) => this.registry.send(channel, event));
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
        const ref = { transport: 'rest' as const, target: info.target };
        this.graph.recordOutbound(
          info.channel,
          info.care === undefined ? ref : { ...ref, care: info.care },
        );
      }
      // The binding summary (RS-42) names `tries xN` only when more than one try is allowed.
      if (info.channel !== undefined && /\btries x\d+/.test(info.care ?? '')) {
        trying.push({ channel: info.channel, subject: `outbound rest '${info.name}'` });
      }
      this.logger.log(info.line);
    }
    return trying;
  }

  /** Boot visibility of the annotated entry points; a discovery failure never breaks boot. */
  private logDiscoveredInbounds(): void {
    const skipped = (error: unknown): void => {
      this.logger.warn(`inbound discovery skipped: ${String(error)}`);
    };
    let inbounds: ReturnType<typeof discoverInbounds> = [];
    try {
      const sources = [...this.discovery.getControllers(), ...this.discovery.getProviders()];
      inbounds = discoverInbounds(sources, {
        methodNames: (proto) => this.metadataScanner.getAllMethodNames(proto),
        onError: skipped,
      });
    } catch (error) {
      skipped(error);
    }
    for (const inbound of inbounds) {
      // RS-03, RS-37: invalid inbound care or carryHeaders fails the boot, outside the guard.
      carriedHeadersOf(inbound.spec);
      const plan = inboundShedPlan(inbound.spec, this.options.inbound, this.care);
      const summary = plan === undefined ? undefined : describeCare(plan);
      this.graph.recordInbound(inbound.spec, summary);
      this.logger.log(summary === undefined ? inbound.line : `${inbound.line} [${summary}]`);
    }
  }

  private hopLoggerInstance: HopLogger | undefined;

  private hopLogger(): HopLogger | undefined {
    this.hopLoggerInstance ??= hopLoggerOf(this.options);
    return this.hopLoggerInstance;
  }

  private activatorDeps(): ActivatorDeps {
    const deps: ActivatorDeps = {
      registry: this.registry,
      trace: this.trace,
      errorChannel: this.options.errorChannel,
      idempotency: this.idempotency,
      care: this.care,
    };
    if (this.options.idempotency?.ttlMs !== undefined) {
      deps.idempotencyTtlMs = this.options.idempotency.ttlMs;
    }
    const log = this.hopLogger();
    if (log !== undefined) deps.logger = log;
    return deps;
  }
}
