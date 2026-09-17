import {
  Inject,
  Injectable,
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
  type InboundAcceptedResponse,
  type InboundDuplicateResponse,
  type InboundSpec,
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
      ),
    );
  }

  private async dispatch(
    spec: InboundSpec,
    extraction: { payload: unknown; rawHeaders: Record<string, unknown> },
    handlerResult: unknown,
  ): Promise<unknown> {
    const mapper = this.mappers.get(spec.transport);
    if (mapper === undefined) throw new InboundError(`sin header-mapper para '${spec.transport}'`);
    const headersInit = mapper.mapIn(extraction.rawHeaders as never);
    const idempotencyKey = headersInit.idempotencyKey;
    const scope = `inbound:${spec.channel}`;
    const idem = this.deps.idempotency;
    if (idem !== undefined && idempotencyKey !== undefined) {
      const duplicate = await this.resolveDuplicate(idem, scope, idempotencyKey, headersInit);
      if (duplicate !== null) return duplicate;
    }
    const msg: IntegrationMessage = createMessage(extraction.payload, headersInit);
    try {
      if (spec.requestReply === true) {
        const result = await this.requestReplyViaGateway(spec, extraction.payload, headersInit);
        await this.completeIdempotency(idem, scope, idempotencyKey, { cachedResult: result });
        return replyResponse(msg, result);
      }
      await this.deps.registry.send(spec.channel, extraction.payload, headersInit);
      await this.completeIdempotency(idem, scope, idempotencyKey, {
        accepted: true,
        id: msg.headers.id,
      });
      return this.acceptedWithMerge(acceptedResponse(msg), handlerResult);
    } catch (error) {
      await this.failIdempotency(idem, scope, idempotencyKey, error);
      throw error;
    }
  }

  private async completeIdempotency(
    idem: IdempotencyService | undefined,
    scope: string,
    key: string | undefined,
    record: Record<string, unknown>,
  ): Promise<void> {
    if (idem === undefined || key === undefined) return;
    await idem.complete(scope, key, record);
  }

  private async failIdempotency(
    idem: IdempotencyService | undefined,
    scope: string,
    key: string | undefined,
    error: unknown,
  ): Promise<void> {
    if (idem === undefined || key === undefined) return;
    await idem.fail(scope, key, error).catch(() => undefined);
  }

  private async resolveDuplicate(
    idem: IdempotencyService,
    scope: string,
    key: string,
    headersInit: MessageHeadersInit,
  ): Promise<InboundDuplicateResponse | null> {
    const acquired = await idem.begin(scope, key);
    if (acquired) return null;
    const record = await idem.get(scope, key);
    const cached =
      record?.result !== undefined && 'cachedResult' in record.result
        ? record.result.cachedResult
        : null;
    const opts: { result: unknown; traceId?: string } = { result: cached };
    if (typeof headersInit.traceId === 'string') opts.traceId = headersInit.traceId;
    return duplicateResponse(key, opts);
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

  private acceptedWithMerge(accepted: InboundAcceptedResponse, handlerResult: unknown): unknown {
    // "+ merge" (spec §7.2): los campos canónicos del accepted ganan
    if (isPlainObject(handlerResult)) return Object.assign({}, handlerResult, accepted);
    return accepted;
  }
}
