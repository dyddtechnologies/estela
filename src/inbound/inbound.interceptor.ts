import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { finalize, mergeMap, type Observable } from 'rxjs';
import { PLAN_B_HEADER, TRIES_LEFT_MESSAGE_HEADER, CareScope } from '../resilience/retry-budget';
import type { CareEngine } from '../resilience/runtime';
import { busy, inboundShedder, inboundTriesLeft, shedContext } from './inbound.resilience';
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

/** Request/reply port, implemented by ReplyGateway (phase 8). */
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
  /** Care engine: inbound lanes and pace, tries left and the plan B mark (RS-27, RS-29, RS-37). */
  care?: CareEngine;
}

/** Request/reply port that also returns the reply headers (ReplyGateway). */
interface MessageReplyPort {
  sendAndReceiveMessage(
    channel: string,
    payload: unknown,
    headers: MessageHeadersInit,
    timeoutMs?: number,
  ): Promise<IntegrationMessage>;
}

function hasMessageReply(port: RequestReplyPort): port is RequestReplyPort & MessageReplyPort {
  return typeof (port as Partial<MessageReplyPort>).sendAndReceiveMessage === 'function';
}

/** DI token of the deps bundle; resolves in any module (global). */
export const INBOUND_DEPS = 'INTEGRATION_INBOUND_DEPS';

/**
 * NestInterceptor (spec sec.7.2): runs the handler (pipes and guards intact),
 * extracts the payload and raw headers, maps tracing and dispatches:
 * requestReply -> ReplyGateway (`{status:'ok'}`) | otherwise -> channel (`{status:'accepted'}`)
 * | idempotency replay -> `{status:'duplicate'}`.
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
    const handle = (): Observable<unknown> =>
      next.handle().pipe(
        mergeMap(async (handlerResult) => {
          const extraction = strategy.extract(context, handlerResult, spec);
          return this.dispatch({ spec, ...extraction, handlerResult, context, receivedAt });
        }),
      );
    const runtime = this.deps.care;
    const shedder =
      runtime === undefined ? undefined : inboundShedder(spec, this.deps.defaults, runtime);
    if (shedder === undefined) return Promise.resolve(handle());
    // RS-37: shed before the handler and the idempotency claim; the slot lives with the reply.
    return shedder.admit(shedContext(context, spec, strategy)).then(
      (release) => handle().pipe(finalize(release)),
      (error: unknown) => {
        throw busy(error, context, spec);
      },
    );
  }

  private dispatch(request: InboundRequestContext): Promise<unknown> {
    const runtime = this.deps.care;
    // RS-70: without any care configuration the request opens no scope, exactly as in 0.9.0.
    if (runtime?.configured !== true) return this.dispatchIn(request, undefined, undefined);
    const triesLeft = inboundTriesLeft(request.rawHeaders, runtime);
    const value = { root: true, ...(triesLeft === undefined ? {} : { triesLeft }) };
    return CareScope.runMessage(value, (frame) => this.dispatchIn(request, frame, triesLeft));
  }

  private async dispatchIn(
    request: InboundRequestContext,
    frame: { planB(): boolean } | undefined,
    triesLeft: number | undefined,
  ): Promise<unknown> {
    const { spec } = request;
    const mapper = this.mappers.get(spec.transport);
    if (mapper === undefined) throw new InboundError(`sin header-mapper para '${spec.transport}'`);
    const headersInit = mapper.mapIn(request.rawHeaders as never);
    if (triesLeft !== undefined) headersInit[TRIES_LEFT_MESSAGE_HEADER] = triesLeft;
    const plan = this.planFor(spec);
    const clientKey =
      plan.clientKey === undefined ? headersInit.idempotencyKey : plan.clientKey(request);
    const keyContext: InboundKeyContext = { ...request, clientKey };
    const claim = await this.gate.claim(plan.idempotency, keyContext);
    const outcome =
      claim.status === 'repeat'
        ? repeatOutcome(claim.repeat, keyContext, headersInit)
        : await this.send(plan, keyContext, claim, headersInit, frame);
    // Mapped after the claim is settled: a mapper throw never triggers the failure policy.
    return plan.reply(buildReplyContext(request, clientKey, outcome));
  }

  private async send(
    plan: InboundPlan,
    request: InboundKeyContext,
    claim: InboundClaim,
    headersInit: MessageHeadersInit,
    frame: { planB(): boolean } | undefined,
  ): Promise<InboundReplyOutcome> {
    const { spec, payload } = request;
    const storageKey = claim.status === 'acquired' ? claim.at.key : undefined;
    const rule = { forward: plan.forward, customClientKey: plan.clientKey !== undefined };
    const headers = forwardedHeaders(rule, headersInit, request.clientKey, storageKey);
    const msg: IntegrationMessage = createMessage(payload, headers);
    let result: unknown;
    let planBReply = false;
    try {
      if (spec.requestReply === true) {
        const reply = await this.requestReplyViaGateway(spec, payload, headers);
        result = reply.payload;
        planBReply = reply.planB;
      } else {
        await this.deps.registry.send(spec.channel, payload, headers);
      }
    } catch (error) {
      await this.gate.failed(claim, error, request);
      throw error;
    }
    const planB = planBReply || frame?.planB() === true;
    if (planB) await this.gate.discard(claim);
    if (spec.requestReply === true) {
      if (!planB) await this.gate.succeed(claim, { cachedResult: result });
      return replyOutcome(msg, result);
    }
    if (!planB) await this.gate.succeed(claim, { accepted: true, id: msg.headers.id });
    return acceptedOutcome(msg, request.handlerResult);
  }

  private async requestReplyViaGateway(
    spec: InboundSpec,
    payload: unknown,
    headersInit: MessageHeadersInit,
  ): Promise<{ payload: unknown; planB: boolean }> {
    const gateway = this.deps.replyGateway;
    if (gateway === undefined) {
      throw new InboundError('requestReply requiere ReplyGateway');
    }
    if (this.deps.care?.configured === true && hasMessageReply(gateway)) {
      const reply = await gateway.sendAndReceiveMessage(
        spec.channel,
        payload,
        headersInit,
        spec.timeoutMs,
      );
      return { payload: reply.payload, planB: reply.headers[PLAN_B_HEADER] === true };
    }
    const result = await gateway.sendAndReceive(spec.channel, payload, headersInit, spec.timeoutMs);
    return { payload: result, planB: false };
  }
}
