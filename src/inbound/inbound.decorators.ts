import { SetMetadata, UseInterceptors } from '@nestjs/common';
import { InboundInterceptor } from './inbound.interceptor';
import { INBOUND_SPEC_METADATA, type InboundSpec, type InboundTransport } from './inbound.types';

/** @Inbound({ transport, ...spec }) — forma generica (spec sec.7.2). */
export function Inbound(spec: InboundSpec): MethodDecorator {
  const setSpec = SetMetadata(INBOUND_SPEC_METADATA, spec);
  return (target, propertyKey, descriptor) => {
    setSpec(target, propertyKey, descriptor);
    return descriptor;
  };
}

function withRestInterceptor(spec: InboundSpec): MethodDecorator {
  const setSpec = SetMetadata(INBOUND_SPEC_METADATA, spec);
  const withInterceptor = UseInterceptors(InboundInterceptor);
  return (target, propertyKey, descriptor) => {
    setSpec(target, propertyKey, descriptor);
    withInterceptor(target, propertyKey, descriptor);
    return descriptor;
  };
}

/** REST: SetMetadata + UseInterceptors(InboundInterceptor) (spec sec.7.2). */
export function InboundRest(
  spec: Omit<InboundSpec, 'transport'> & { transport?: InboundTransport },
): MethodDecorator {
  return withRestInterceptor({ ...spec, transport: 'rest' });
}

/** gRPC: SetMetadata + interceptor (spec sec.7.2). */
export function InboundGrpc(
  spec: Omit<InboundSpec, 'transport'> & { transport?: InboundTransport },
): MethodDecorator {
  return withRestInterceptor({ ...spec, transport: 'grpc' });
}

/** GraphQL (extension ADR-015): same pipeline; operation informativa. */
export function InboundGraphQL(
  spec: Omit<InboundSpec, 'transport'> & { transport?: InboundTransport },
): MethodDecorator {
  return withRestInterceptor({ ...spec, transport: 'graphql' });
}

/** Rabbit: SOLO metadata — el binding real vive en InboundExplorer (spec sec.7.2). */
export function InboundRabbit(
  spec: Omit<InboundSpec, 'transport'> & { transport?: InboundTransport },
): MethodDecorator {
  return Inbound({ ...spec, transport: 'rabbit' });
}
