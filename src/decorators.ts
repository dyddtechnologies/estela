import 'reflect-metadata';

/** Metadatos de activators (spec §7.1). Único punto que toca APIs de metadata. */
export const ACTIVATOR_METADATA = 'integration:activator';

export type ActivatorKind = 'service-activator' | 'pubsub';

export interface ActivatorOptions {
  group?: string;
  routingKey?: string;
}

export interface ActivatorMetadata extends ActivatorOptions {
  channel: string;
  kind: ActivatorKind;
}

function defineActivator(kind: ActivatorKind, channel: string, options: ActivatorOptions): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    const metadata: ActivatorMetadata = { channel, kind };
    if (options.group !== undefined) metadata.group = options.group;
    if (options.routingKey !== undefined) metadata.routingKey = options.routingKey;
    Reflect.defineMetadata(ACTIVATOR_METADATA, metadata, target, propertyKey);
    return descriptor;
  };
}

/** `@ServiceActivator(channel, { group?, routingKey? })` (spec §7.1). */
export function ServiceActivator(channel: string, options: ActivatorOptions = {}): MethodDecorator {
  return defineActivator('service-activator', channel, options);
}

/** Alias semántico de pubsub (spec §7.1). */
export function PubSub(channel: string, options: ActivatorOptions = {}): MethodDecorator {
  return defineActivator('pubsub', channel, options);
}
