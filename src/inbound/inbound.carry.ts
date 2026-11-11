import { normalizeHeaderValue } from '../adapters/header-mapper';
import { isReservedHeader, type MessageHeadersInit } from '../message';
import { InboundError, type InboundSpec } from './inbound.types';

/** One allowed transport header and the message header it lands on. */
export interface CarriedHeader {
  /** Transport header name, lower-cased (HTTP and gRPC metadata names are case-insensitive). */
  readonly from: string;
  /** Message header name, as written by the endpoint. */
  readonly to: string;
}

function pairsOf(option: NonNullable<InboundSpec['carryHeaders']>): [string, string][] {
  if (Array.isArray(option)) {
    return (option as readonly string[]).map((name) => [name, name]);
  }
  return Object.entries(option as Readonly<Record<string, string>>);
}

const isName = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function problemOf(from: unknown, to: unknown, targets: ReadonlySet<string>): string | undefined {
  if (!isName(from) || !isName(to)) return 'names must be non-empty strings';
  if (isReservedHeader(to)) return `target '${to}' is a reserved header`;
  if (targets.has(to)) return `target '${to}' is used twice`;
  return undefined;
}

/**
 * Validated allowlist of `spec.carryHeaders`, or undefined when the endpoint sets none.
 * Throws `InboundError` on Rabbit, on an empty name, on a reserved target and on a target
 * used twice. Called at boot (discovery) and on the first request of the endpoint.
 */
export function carriedHeadersOf(spec: InboundSpec): readonly CarriedHeader[] | undefined {
  const option = spec.carryHeaders;
  if (option === undefined) return undefined;
  const where = `inbound '${spec.channel}': carryHeaders`;
  if (spec.transport === 'rabbit') {
    throw new InboundError(`${where} is not supported on @InboundRabbit`);
  }
  const carried: CarriedHeader[] = [];
  const targets = new Set<string>();
  for (const [from, to] of pairsOf(option)) {
    const problem = problemOf(from, to, targets);
    if (problem !== undefined) throw new InboundError(`${where} ${problem}`);
    targets.add(to);
    carried.push({ from: from.toLowerCase(), to });
  }
  return carried;
}

/** Message header names an endpoint carries, sorted (graph); never values. */
export function carriedHeaderNames(spec: InboundSpec): string[] | undefined {
  const option = spec.carryHeaders;
  if (option === undefined) return undefined;
  return pairsOf(option)
    .map(([, to]) => to)
    .sort((a, b) => a.localeCompare(b));
}

/** Copies the allowed transport headers present in `raw` into `headers` (string values only). */
export function carryInto(
  headers: MessageHeadersInit,
  raw: Record<string, unknown>,
  carried: readonly CarriedHeader[],
): void {
  const byName = new Map<string, unknown>();
  for (const [name, value] of Object.entries(raw)) byName.set(name.toLowerCase(), value);
  for (const { from, to } of carried) {
    const value = normalizeHeaderValue(byName.get(from));
    if (value !== undefined) headers[to] = value;
  }
}
