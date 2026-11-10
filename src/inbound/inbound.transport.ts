import type { ExecutionContext } from '@nestjs/common';
import type { InboundSpec, InboundTransport } from './inbound.types';

export interface InboundExtraction {
  payload: unknown;
  rawHeaders: Record<string, unknown>;
}

/**
 * Strategy por transporte (plan sec.5.1): extraen payload + headers crudos; el
 * mapeo a `MessageHeaders` vive en los HeaderMapper (sec.4).
 */
export interface InboundTransportStrategy {
  readonly transport: InboundTransport;
  extract(context: ExecutionContext, handlerResult: unknown, spec: InboundSpec): InboundExtraction;
  /** Raw headers before the handler runs (inbound `pace.key`, RS-37). Optional: `{}` without it. */
  rawHeaders?(context: ExecutionContext): Record<string, unknown>;
}

export class HttpInboundStrategy implements InboundTransportStrategy {
  readonly transport = 'rest' as const;

  rawHeaders(context: ExecutionContext): Record<string, unknown> {
    const request = context.switchToHttp().getRequest<Record<string, unknown> | undefined>();
    return (request?.headers ?? {}) as Record<string, unknown>;
  }

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

  rawHeaders(context: ExecutionContext): Record<string, unknown> {
    const metadata = context.switchToRpc().getContext<GrpcMetadataLike | undefined>();
    if (typeof metadata?.toJSON === 'function') return metadata.toJSON();
    return (metadata ?? {}) as Record<string, unknown>;
  }

  extract(context: ExecutionContext, handlerResult: unknown, spec: InboundSpec): InboundExtraction {
    const rpc = context.switchToRpc();
    const data = rpc.getData<unknown>();
    const metadata = rpc.getContext<GrpcMetadataLike>() as unknown as GrpcMetadataLike | undefined;
    const rawHeaders =
      typeof metadata?.toJSON === 'function'
        ? metadata.toJSON()
        : ((metadata ?? {}) as Record<string, unknown>);
    const payload = spec.payload === 'body' ? data : (handlerResult ?? data);
    return { payload, rawHeaders };
  }
}

export class GraphQLInboundStrategy implements InboundTransportStrategy {
  readonly transport = 'graphql' as const;

  rawHeaders(context: ExecutionContext): Record<string, unknown> {
    const gqlContext = context.getArgs()[2] as
      | { req?: { headers?: Record<string, unknown> }; extensions?: Record<string, unknown> }
      | undefined;
    return gqlContext?.req?.headers ?? gqlContext?.extensions ?? {};
  }

  extract(context: ExecutionContext, handlerResult: unknown, spec: InboundSpec): InboundExtraction {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment -- getArgs() es any[] en Nest */
    const args = context.getArgs();
    const resolverArgs = args[1] ?? args;
    const gqlContext = args[2] as
      | { req?: { headers?: Record<string, unknown> }; extensions?: Record<string, unknown> }
      | undefined;
    const rawHeaders = gqlContext?.req?.headers ?? gqlContext?.extensions ?? {};
    const payload = spec.payload === 'body' ? resolverArgs : (handlerResult ?? resolverArgs);
    return { payload, rawHeaders };
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  }
}
