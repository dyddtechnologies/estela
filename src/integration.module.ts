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
import { discoverInbounds } from './inbound/inbound.discovery';
import { serializeError } from './flow/flow-step';
import { FlowExecutor, type FlowDeps } from './flow/flow-executor';
import type { FlowDefinition } from './flow/integration-flow';
import { IdempotencyService } from './idempotency/idempotency.service';
import type { IdempotencyStore } from './idempotency/idempotency-store';
import { createMessage } from './message';
import { ReplyGateway } from './gateway/reply-gateway';
import { ChannelGraph } from './graph/channel-graph';
import { ChannelGraphController } from './graph/channel-graph.controller';
import { TraceContext } from './trace/trace-context';
import { subscribeActivator, type ActivatorDeps } from './activator/activator-wrapper';
import { HopLogger, type IntegrationLoggingOptions } from './trace/hop-logger';
import { printEstelaBanner } from './trace/banner';
import { OutboundRestGateway } from './outbound/outbound-rest.gateway';
import {
  OUTBOUND_REST_METADATA,
  outboundRestBindingOf,
  type OutboundRestSpec,
} from './outbound/outbound.decorators';
import type { OutboundModuleOptions } from './outbound/outbound.types';

export const INTEGRATION_OPTIONS = 'INTEGRATION_OPTIONS';

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
    ): InboundInterceptorDeps => ({
      registry,
      trace,
      idempotency,
      replyGateway: gateway,
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
    ): OutboundRestGateway => {
      const defaults = opts.outbound?.rest?.defaults;
      const logger = hopLoggerOf(opts);
      return new OutboundRestGateway({
        registry,
        trace,
        ...(defaults === undefined ? {} : { defaults }),
        ...(logger === undefined ? {} : { logger }),
        resolver: { resolve: (token) => moduleRef.get(token, { strict: false }) },
      });
    },
    inject: [ChannelRegistry, TraceContext, INTEGRATION_OPTIONS, ModuleRef],
  };
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
  ) {}

  /** Orden strict (spec sec.11): channels -> activators -> flows -> explorer. */
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

    // 2. activators (DiscoveryModule)
    this.subscribeDiscoveredActivators();
    this.logDiscoveredInbounds();
    this.bindOutbounds();

    // 3. flows: graph.recordFlow + flow.bind + attach (spec sec.11 step 3)
    for (const definition of this.options.flows) {
      const built = definition.build().build();
      this.graph.recordFlow(definition.name, built);
      const executorDeps: FlowDeps = {
        registry: this.registry,
        trace: this.trace,
        errorChannel: this.options.errorChannel,
        idempotency: this.idempotency,
      };
      if (this.options.idempotency?.ttlMs !== undefined) {
        executorDeps.idempotencyTtlMs = this.options.idempotency.ttlMs;
      }
      const flowLog = this.hopLogger();
      if (flowLog !== undefined) executorDeps.logger = flowLog;
      const executor = new FlowExecutor(definition.name, built, executorDeps);
      executor.attachTo(this.registry);
    }

    // 4. explorer (rabbit) — ultimo
    await this.explorer.onModuleInit();
  }

  /** Shutdown: drain de queues (plan sec.8.6/sec.9.10). */
  async onApplicationShutdown(): Promise<void> {
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

  private subscribeDiscoveredActivators(): void {
    const found = this.annotatedMethods<ActivatorMetadata>(ACTIVATOR_METADATA);
    for (const { instance, methodName, metadata } of found) {
      subscribeActivator({ instance, methodName, metadata }, this.activatorDeps());
      this.graph.recordActivator(metadata.channel, `${instance.constructor.name}.${methodName}`);
      this.logger.log(
        `activator: ${instance.constructor.name}.${methodName} -> ${metadata.channel}`,
      );
    }
  }

  /**
   * Declared outbound bindings (module options, then `@OutboundRest` methods): bound, logged
   * with one line each and recorded in the graph. A misconfigured binding fails the boot.
   */
  private bindOutbounds(): void {
    for (const binding of this.options.outbound?.rest?.bindings ?? []) {
      this.outbound.bind(binding);
    }
    const annotated = this.annotatedMethods<OutboundRestSpec>(OUTBOUND_REST_METADATA);
    for (const { instance, methodName, metadata } of annotated) {
      this.outbound.bind(outboundRestBindingOf(instance, methodName, metadata));
    }
    for (const info of this.outbound.bindings()) {
      if (info.channel !== undefined) {
        this.graph.recordOutbound(info.channel, { transport: 'rest', target: info.target });
      }
      this.logger.log(info.line);
    }
  }

  /** Boot visibility of the annotated entry points; a discovery failure never breaks boot. */
  private logDiscoveredInbounds(): void {
    const skipped = (error: unknown): void => {
      this.logger.warn(`inbound discovery skipped: ${String(error)}`);
    };
    try {
      const sources = [...this.discovery.getControllers(), ...this.discovery.getProviders()];
      const inbounds = discoverInbounds(sources, {
        methodNames: (proto) => this.metadataScanner.getAllMethodNames(proto),
        onError: skipped,
      });
      for (const inbound of inbounds) {
        this.graph.recordInbound(inbound.spec);
        this.logger.log(inbound.line);
      }
    } catch (error) {
      skipped(error);
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
    };
    if (this.options.idempotency?.ttlMs !== undefined) {
      deps.idempotencyTtlMs = this.options.idempotency.ttlMs;
    }
    const log = this.hopLogger();
    if (log !== undefined) deps.logger = log;
    return deps;
  }
}
