import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { mergeMap, type Observable } from 'rxjs';
import type { ChannelRegistry } from '../channel-registry';
import {
  AmqpHeaderMapper,
  GraphQLHeaderMapper,
  GrpcHeaderMapper,
  HttpHeaderMapper,
  type HeaderMapper,
} from '../adapters/header-mapper';
import {
  createMessage,
  type IntegrationMessage,
  type MessageHeadersInit,
} from '../message';
import { IdempotencyService } from '../idempotency/idempotency.service';
import type { TraceContext } from '../trace/trace-context';
import {
  GraphQLInboundStrategy,
  GrpcInboundStrategy,
  HttpInboundStrategy,
  type InboundTransportStrategy,
} from './inbound.transport';
import {
  acceptedResponse,
  duplicateResponse,
  InboundError,
  readInboundSpec,
  replyResponse,
} from './inbound.types';

/** Puerto request/reply — implementado por ReplyGateway en Fase 8. */
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
}

/** Token DI del bundle de deps — resuelve en cualquier módulo (global). */
export const INBOUND_DEPS = 'INTEGRATION_INBOUND_DEPS';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * NestInterceptor (spec §7.2): ejecuta el handler (pipes/guards intactos),
 * extrae payload + headers crudos, mapea trazas y despacha:
 * requestReply → ReplyGateway (`{status:'ok'}`) | si no → canal (`{status:'accepted'}`)
 * | replay de idempotencia → `{status:'duplicate'}`.
 */
@Injectable()
export class InboundInterceptor implements NestInterceptor {
  private readonly strategies = new Map<string, InboundTransportStrategy>();
  private readonly mappers = new Map<string, HeaderMapper<never>>();

  constructor(@Inject(INBOUND_DEPS) private readonly deps: InboundInterceptorDeps) {
    const defaults: readonly InboundTransportStrategy[] =
      deps.strategies ?? [new HttpInboundStrategy(), new GrpcInboundStrategy(), new GraphQLInboundStrategy()];
    for (const strategy of defaults) this.strategies.set(strategy.transport, strategy);
    this.mappers.set('rest', new HttpHeaderMapper() as HeaderMapper<never>);
    this.mappers.set('grpc', new GrpcHeaderMapper() as HeaderMapper<never>);
    this.mappers.set('graphql', new GraphQLHeaderMapper() as HeaderMapper<never>);
    this.mappers.set('rabbit', new AmqpHeaderMapper() as HeaderMapper<never>);
  }

  intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const spec = readInboundSpec(context.getHandler());
    if (spec === undefined) return Promise.resolve(next.handle());
    const strategy = this.strategies.get(spec.transport);
    if (strategy === undefined) {
      return Promise.reject(new InboundError(`sin strategy para transporte '${spec.transport}'`));
    }
    return Promise.resolve(
      next.handle().pipe(
        mergeMap(async (handlerResult) => {
          const extraction = strategy.extract(context, handlerResult, spec);
          return this.dispatch(spec, extraction, handlerResult);
        }),
      ) as Observable<unknown>,
    );
  }

  private async dispatch(
    spec: import('./inbound.types').InboundSpec,
    extraction: { payload: unknown; rawHeaders: Record<string, unknown> },
    handlerResult: unknown,
  ): Promise<unknown> {
    const mapper = this.mappers.get(spec.transport);
    if (mapper === undefined) throw new InboundError(`sin header-mapper para '${spec.transport}'`);
    const headersInit = mapper.mapIn(extraction.rawHeaders as never) as MessageHeadersInit;
    const idempotencyKey = headersInit.idempotencyKey;
    const scope = `inbound:${spec.channel}`;
    const idem = this.deps.idempotency;
    if (idem !== undefined && idempotencyKey !== undefined) {
      const acquired = await idem.begin(scope, idempotencyKey);
      if (!acquired) {
        const record = await idem.get(scope, idempotencyKey);
        const cached =
          record?.result !== undefined && 'cachedResult' in record.result
            ? record.result['cachedResult']
            : null;
        const dupOpts: { result: unknown; traceId?: string } = { result: cached };
        if (typeof headersInit.traceId === 'string') dupOpts.traceId = headersInit.traceId;
        return duplicateResponse(idempotencyKey, dupOpts);
      }
    }
    const msg: IntegrationMessage = createMessage(extraction.payload, headersInit);
    try {
      if (spec.requestReply === true) {
        if (this.deps.replyGateway === undefined) {
          throw new InboundError('requestReply requiere ReplyGateway (Fase 8)');
        }
        const result = await this.deps.replyGateway.sendAndReceive(
          spec.channel,
          extraction.payload,
          headersInit,
          spec.timeoutMs,
        );
        if (idem !== undefined && idempotencyKey !== undefined) {
          await idem.complete(scope, idempotencyKey, { cachedResult: result });
        }
        return replyResponse(msg, result);
      }
      await this.deps.registry.send(spec.channel, extraction.payload, headersInit);
      if (idem !== undefined && idempotencyKey !== undefined) {
        await idem.complete(scope, idempotencyKey, { accepted: true, id: msg.headers.id });
      }
      const accepted = acceptedResponse(msg);
      if (isPlainObject(handlerResult)) {
        return Object.assign({}, handlerResult, accepted); // "+ merge" (spec §7.2)
      }
      return accepted;
    } catch (error) {
      if (idem !== undefined && idempotencyKey !== undefined) {
        await idem.fail(scope, idempotencyKey, error).catch(() => undefined);
      }
      throw error;
    }
  }
}
