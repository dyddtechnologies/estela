import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { mergeMap, type Observable } from 'rxjs';
import type { ChannelRegistry } from '../channel-registry';
import {
  AmqpHeaderMapper,
  GraphQLHeaderMapper,
  GrpcHeaderMapper,
  HttpHeaderMapper,
  type HeaderMapper,
} from '../adapters/header-mapper';
import { createMessage, type IntegrationMessage, type MessageHeadersInit } from '../message';
import type { IdempotencyService } from '../idempotency/idempotency.service';
import type { TraceContext } from '../trace/trace-context';
import {
  GraphQLInboundStrategy,
  GrpcInboundStrategy,
  HttpInboundStrategy,
  type InboundTransportStrategy,
} from './inbound.transport';
import { InboundIdempotencyGate, forwardedHeaders, type InboundClaim } from './inbound.idempotency';
import { createInboundPlanner, type InboundPlan } from './inbound.plan';
import {
  acceptedOutcome,
  buildReplyContext,
  repeatOutcome,
  replyOutcome,
  type InboundReplyOutcome,
} from './inbound.reply';
import {
  InboundError,
  readInboundSpec,
  type InboundDefaults,
  type InboundKeyContext,
  type InboundProviderResolver,
  type InboundRequestContext,
  type InboundSpec,
} from './inbound.types';

/** Port request/reply — implementado por ReplyGateway en Fase 8. */
export interface RequestReplyPort {
  sendAndReceive(
    channel: string,
    payload: unknown,
    headers: MessageHeadersInit,
    timeoutMs?: number,
  ): Promise<unknown>;
}

export interface InboundInterceptorDeps {
  registry: ChannelRegistry;
  trace: TraceContext;
  idempotency?: IdempotencyService;
  replyGateway?: RequestReplyPort;
  strategies?: readonly InboundTransportStrategy[];
  /** Module-wide reply and idempotency defaults (`forRoot({ inbound })`). */
  defaults?: InboundDefaults;
  /** Resolves `{ useExisting }` strategies; without it only functions and instances work. */
  resolver?: InboundProviderResolver;
}

/** Token DI del bundle de deps — resuelve en cualquier modulo (global). */
export const INBOUND_DEPS = 'INTEGRATION_INBOUND_DEPS';

/**
 * NestInterceptor (spec sec.7.2): executes el handler (pipes/guards intactos),
 * extrae payload + headers crudos, mapea tracing y despacha:
 * requestReply -> ReplyGateway (`{status:'ok'}`) | si no -> channel (`{status:'accepted'}`)
 * | replay de idempotency -> `{status:'duplicate'}`.
 *
 * Since 0.6.0 the reply shape and the idempotency rules are a per-endpoint plan
 * (`InboundSpec.reply` / `InboundSpec.idempotency` over the module defaults); with nothing
 * configured the plan reproduces the behaviour above.
 */
@Injectable()
export class InboundInterceptor implements NestInterceptor {
  private readonly strategies = new Map<string, InboundTransportStrategy>();
  private readonly mappers = new Map<string, HeaderMapper<never>>();
  private readonly planFor: (spec: InboundSpec) => InboundPlan;
  private readonly gate: InboundIdempotencyGate;

  constructor(@Inject(INBOUND_DEPS) private readonly deps: InboundInterceptorDeps) {
    const defaults: readonly InboundTransportStrategy[] = deps.strategies ?? [
      new HttpInboundStrategy(),
      new GrpcInboundStrategy(),
      new GraphQLInboundStrategy(),
    ];
    for (const strategy of defaults) this.strategies.set(strategy.transport, strategy);
    this.mappers.set('rest', new HttpHeaderMapper());
    this.mappers.set('grpc', new GrpcHeaderMapper());
    this.mappers.set('graphql', new GraphQLHeaderMapper());
    this.mappers.set('rabbit', new AmqpHeaderMapper());
    this.planFor = createInboundPlanner(deps);
    const logger = new Logger('InboundInterceptor');
    this.gate = new InboundIdempotencyGate((message) => logger.warn(message));
  }

  intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const spec = readInboundSpec(context.getHandler());
    if (spec === undefined) return Promise.resolve(next.handle());
    const strategy = this.strategies.get(spec.transport);
    if (strategy === undefined) {
      return Promise.reject(new InboundError(`sin strategy para transporte '${spec.transport}'`));
    }
    const receivedAt = Date.now();
    return Promise.resolve(
      next.handle().pipe(
        mergeMap(async (handlerResult) => {
          const extraction = strategy.extract(context, handlerResult, spec);
          return this.dispatch({ spec, ...extraction, handlerResult, context, receivedAt });
        }),
      ),
    );
  }

  private async dispatch(request: InboundRequestContext): Promise<unknown> {
    const { spec } = request;
    const mapper = this.mappers.get(spec.transport);
    if (mapper === undefined) throw new InboundError(`sin header-mapper para '${spec.transport}'`);
    const headersInit = mapper.mapIn(request.rawHeaders as never);
    const plan = this.planFor(spec);
    const clientKey =
      plan.clientKey === undefined ? headersInit.idempotencyKey : plan.clientKey(request);
    const keyContext: InboundKeyContext = { ...request, clientKey };
    const claim = await this.gate.claim(plan.idempotency, keyContext);
    const outcome =
      claim.status === 'repeat'
        ? repeatOutcome(claim.repeat, keyContext, headersInit)
        : await this.send(plan, keyContext, claim, headersInit);
    // Mapped after the claim is settled: a mapper throw never triggers the failure policy.
    return plan.reply(buildReplyContext(request, clientKey, outcome));
  }

  private async send(
    plan: InboundPlan,
    request: InboundKeyContext,
    claim: InboundClaim,
    headersInit: MessageHeadersInit,
  ): Promise<InboundReplyOutcome> {
    const { spec, payload } = request;
    const storageKey = claim.status === 'acquired' ? claim.at.key : undefined;
    const rule = { forward: plan.forward, customClientKey: plan.clientKey !== undefined };
    const headers = forwardedHeaders(rule, headersInit, request.clientKey, storageKey);
    const msg: IntegrationMessage = createMessage(payload, headers);
    let result: unknown;
    try {
      if (spec.requestReply === true) {
        result = await this.requestReplyViaGateway(spec, payload, headers);
      } else {
        await this.deps.registry.send(spec.channel, payload, headers);
      }
    } catch (error) {
      await this.gate.failed(claim, error, request);
      throw error;
    }
    if (spec.requestReply === true) {
      await this.gate.succeed(claim, { cachedResult: result });
      return replyOutcome(msg, result);
    }
    await this.gate.succeed(claim, { accepted: true, id: msg.headers.id });
    return acceptedOutcome(msg, request.handlerResult);
  }

  private async requestReplyViaGateway(
    spec: InboundSpec,
    payload: unknown,
    headersInit: MessageHeadersInit,
  ): Promise<unknown> {
    if (this.deps.replyGateway === undefined) {
      throw new InboundError('requestReply requiere ReplyGateway');
    }
    return this.deps.replyGateway.sendAndReceive(
      spec.channel,
      payload,
      headersInit,
      spec.timeoutMs,
    );
  }
}
