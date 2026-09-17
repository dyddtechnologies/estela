import type { ExecutionContext } from '@nestjs/common';
import type { InboundSpec, InboundTransport } from './inbound.types';

export interface InboundExtraction {
  payload: unknown;
  rawHeaders: Record<string, unknown>;
}

/**
 * Strategy por transporte (plan §5.1): extraen payload + headers crudos; el
 * mapeo a `MessageHeaders` vive en los HeaderMapper (§4).
 */
export interface InboundTransportStrategy {
  readonly transport: InboundTransport;
  extract(context: ExecutionContext, handlerResult: unknown, spec: InboundSpec): InboundExtraction;
}

export class HttpInboundStrategy implements InboundTransportStrategy {
  readonly transport = 'rest' as const;

  extract(context: ExecutionContext, handlerResult: unknown, spec: InboundSpec): InboundExtraction {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const rawHeaders = (request?.headers ?? {}) as Record<string, unknown>;
    const body = request?.body;
    const payload = spec.payload === 'body' ? body : (handlerResult ?? body);
    return { payload, rawHeaders };
  }
}

interface GrpcMetadataLike {
  toJSON?: () => Record<string, unknown>;
}

export class GrpcInboundStrategy implements InboundTransportStrategy {
  readonly transport = 'grpc' as const;

  extract(context: ExecutionContext, handlerResult: unknown, spec: InboundSpec): InboundExtraction {
    const rpc = context.switchToRpc();
    const data = rpc.getData<unknown>();
    const metadata = rpc.getContext<GrpcMetadataLike>();
    const rawHeaders =
      typeof metadata?.toJSON === 'function' ? metadata.toJSON() : ((metadata ?? {}) as Record<string, unknown>);
    const payload = spec.payload === 'body' ? data : (handlerResult ?? data);
    return { payload, rawHeaders };
  }
}

export class GraphQLInboundStrategy implements InboundTransportStrategy {
  readonly transport = 'graphql' as const;

  extract(context: ExecutionContext, handlerResult: unknown, spec: InboundSpec): InboundExtraction {
    const args = context.getArgs() as Array<Record<string, unknown>>;
    const resolverArgs = args[1] ?? args;
    const gqlContext = args[2] as
      | { req?: { headers?: Record<string, unknown> }; extensions?: Record<string, unknown> }
      | undefined;
    const rawHeaders = gqlContext?.req?.headers ?? gqlContext?.extensions ?? {};
    const payload = spec.payload === 'body' ? resolverArgs : (handlerResult ?? resolverArgs);
    return { payload, rawHeaders };
  }
}
