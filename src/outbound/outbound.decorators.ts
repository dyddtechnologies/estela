import 'reflect-metadata';

import { OutboundError } from './outbound.errors';
import type {
  OutboundRequestContext,
  OutboundRestBinding,
  OutboundRestTarget,
} from './outbound.types';

export const OUTBOUND_REST_METADATA = 'integration:outbound-rest';

/** Options of `@OutboundRest`: a binding whose target resolver is the annotated method. */
export type OutboundRestSpec = Omit<OutboundRestBinding, 'target'>;

/**
 * `@OutboundRest({ channel, ...options })` declares an outbound REST binding on a provider
 * method. The method is the target resolver: it receives `(payload, message)` and returns
 * the `OutboundRestTarget` of that message (it may be async). The runtime performs the call
 * and replies on `headers.replyChannel`.
 */
export function OutboundRest(spec: OutboundRestSpec): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    Reflect.defineMetadata(OUTBOUND_REST_METADATA, spec, target, propertyKey);
    return descriptor;
  };
}

export function readOutboundRestSpec(
  prototype: object,
  methodName: string,
): OutboundRestSpec | undefined {
  return Reflect.getMetadata(OUTBOUND_REST_METADATA, prototype, methodName) as
    OutboundRestSpec | undefined;
}

type TargetMethod = (
  payload: unknown,
  message: OutboundRequestContext['message'],
) => OutboundRestTarget | Promise<OutboundRestTarget>;

/** Binding of an annotated method: the spec plus the method as target resolver. */
export function outboundRestBindingOf(
  instance: object,
  methodName: string,
  spec: OutboundRestSpec,
): OutboundRestBinding {
  const method = (instance as Record<string, TargetMethod | undefined>)[methodName];
  if (typeof method !== 'function') {
    throw new OutboundError(`outbound rest: method '${methodName}' was not found`);
  }
  return { ...spec, target: (ctx) => method.call(instance, ctx.payload, ctx.message) };
}
