import { RequestMethod } from '@nestjs/common';
import { INBOUND_SPEC_METADATA, type InboundSpec } from './inbound.types';

// Metadata keys written by Nest decorators. Read by name so that the optional
// packages (@nestjs/microservices, @nestjs/graphql) are never imported.
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const PATTERN_METADATA = 'microservices:pattern';
const GRAPHQL_NAME_METADATA = 'graphql:resolver_name';
const GRAPHQL_TYPE_METADATA = 'graphql:resolver_type';

/** Minimal shape of a Nest `InstanceWrapper` (controller or provider). */
export interface InboundDiscoverySource {
  instance: unknown;
}

export interface InboundDiscoveryOptions {
  /** `MetadataScanner.getAllMethodNames` of the host application. */
  methodNames: (prototype: object) => string[];
  /** Called when a controller or provider cannot be inspected; it is then skipped. */
  onError?: (error: unknown) => void;
}

export interface DiscoveredInbound {
  spec: InboundSpec;
  /** `Class.method` that carries the annotation. */
  handler: string;
  /** Boot log line, e.g. `inbound rest: POST /orders -> orders.place (request-reply)`. */
  line: string;
}

function readMetadata(key: string, target: object): unknown {
  return Reflect.getMetadata(key, target);
}

function pathList(value: unknown): string[] {
  const candidates: unknown[] = Array.isArray(value) ? value : [value];
  const paths = candidates.filter((item): item is string => typeof item === 'string');
  return paths.length > 0 ? paths : [''];
}

function joinPath(prefix: string, suffix: string): string {
  const segments = [...prefix.split('/'), ...suffix.split('/')].filter((part) => part.length > 0);
  return `/${segments.join('/')}`;
}

function describeRest(controller: object, handler: object): string | undefined {
  const method: unknown = readMetadata(METHOD_METADATA, handler);
  if (typeof method !== 'number') return undefined;
  const verb = (RequestMethod as Record<number, string | undefined>)[Number(method)];
  if (verb === undefined) return undefined;
  const routes: string[] = [];
  for (const prefix of pathList(readMetadata(PATH_METADATA, controller))) {
    for (const suffix of pathList(readMetadata(PATH_METADATA, handler))) {
      routes.push(joinPath(prefix, suffix));
    }
  }
  return `${verb} ${routes.join(' | ')}`;
}

function describeGrpc(handler: object): string | undefined {
  const metadata: unknown = readMetadata(PATTERN_METADATA, handler);
  const pattern: unknown = Array.isArray(metadata) ? metadata[0] : metadata;
  if (pattern === null || typeof pattern !== 'object') return undefined;
  const { service, rpc } = pattern as { service?: unknown; rpc?: unknown };
  if (typeof service !== 'string' || typeof rpc !== 'string') return undefined;
  return `${service}/${rpc}`;
}

function describeGraphql(handler: object, spec: InboundSpec, methodName: string): string {
  const type: unknown = readMetadata(GRAPHQL_TYPE_METADATA, handler);
  const name: unknown = readMetadata(GRAPHQL_NAME_METADATA, handler);
  const operation = spec.operation ?? (typeof type === 'string' ? type.toLowerCase() : undefined);
  const field = typeof name === 'string' && name.length > 0 ? name : methodName;
  return operation === undefined ? field : `${operation} ${field}`;
}

function describeEntryPoint(
  controller: object,
  handler: object,
  spec: InboundSpec,
  methodName: string,
): string | undefined {
  if (spec.transport === 'rest') return describeRest(controller, handler);
  if (spec.transport === 'grpc') return describeGrpc(handler);
  if (spec.transport === 'graphql') return describeGraphql(handler, spec, methodName);
  return undefined;
}

/** Class (constructor) that hosts the annotated method. */
export type InboundHost = object & { name: string };

/**
 * Builds the boot log line of one annotated endpoint. Only transport, route or
 * pattern, channel and the request-reply flag are printed; never option values.
 * Falls back to `Class.method` when the route metadata is missing or unreadable.
 */
export function describeInbound(
  host: InboundHost,
  methodName: string,
  handler: object,
  spec: InboundSpec,
): string {
  let entryPoint: string | undefined;
  try {
    entryPoint = describeEntryPoint(host, handler, spec, methodName);
  } catch {
    entryPoint = undefined;
  }
  const target = entryPoint ?? `${host.name}.${methodName}`;
  const suffix = spec.requestReply === true ? ' (request-reply)' : '';
  return `inbound ${spec.transport}: ${target} -> ${spec.channel}${suffix}`;
}

function discoverFromInstance(
  instance: object,
  methodNames: (prototype: object) => string[],
): DiscoveredInbound[] {
  const found: DiscoveredInbound[] = [];
  const host: InboundHost = instance.constructor;
  let proto: object | null = Object.getPrototypeOf(instance) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    const members = proto as Record<string, unknown>;
    for (const methodName of methodNames(proto)) {
      const handler = Object.getOwnPropertyDescriptor(members, methodName)?.value as unknown;
      if (typeof handler !== 'function') continue;
      const spec = readMetadata(INBOUND_SPEC_METADATA, handler) as InboundSpec | undefined;
      if (spec === undefined) continue;
      found.push({
        spec,
        handler: `${host.name}.${methodName}`,
        line: describeInbound(host, methodName, handler, spec),
      });
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return found;
}

/**
 * Finds every controller or provider method annotated with `@Inbound*`.
 * Never throws: a source that cannot be inspected is reported and skipped.
 */
export function discoverInbounds(
  sources: Iterable<InboundDiscoverySource>,
  options: InboundDiscoveryOptions,
): DiscoveredInbound[] {
  const found: DiscoveredInbound[] = [];
  for (const source of sources) {
    try {
      const instance: unknown = source.instance;
      if (instance === null || typeof instance !== 'object') continue;
      found.push(...discoverFromInstance(instance, options.methodNames));
    } catch (error) {
      options.onError?.(error);
    }
  }
  return found;
}
