import { Logger } from '@nestjs/common';
import type { ChannelSpec } from './channel-factory';
import type { ActivatorMetadata } from './decorators';
import type {
  InboundDefaults,
  InboundIdempotencyOptions,
  InboundSpec,
} from './inbound/inbound.types';
import type { CareEdge, CareEvent } from './resilience/resilience.types';
import type { PrivacyLevel, PrivacyScope, PrivacyScopes } from './sensitive/policy-resolver';
import type { PrivacyEngine, PrivacyLogger } from './sensitive/privacy-engine';
import {
  PRIVACY_FINDING_CODES,
  PrivacyConfigError,
  type PrivacyFinding,
} from './sensitive/privacy-errors';
import type { PrivacyRef, Remember } from './sensitive/privacy.types';

/**
 * Privacy scopes the module collects at boot (SPI-433, 6.6): one per channel that declares
 * `privacy`, activator and inbound endpoint. Names: `channel:<name>`, `activator:<Class>.<method>`,
 * `inbound:<channel>`.
 */

export function nestPrivacyLogger(): PrivacyLogger {
  const logger = new Logger('EstelaPrivacy');
  return {
    log: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  };
}

function level(kind: PrivacyLevel['kind'], subject: string, ref: PrivacyRef | undefined) {
  const out: PrivacyLevel = { kind, subject, ref };
  return out;
}

/** The L2 level of a channel, or none when it declares no privacy. */
export function channelLevels(
  channels: readonly ChannelSpec[],
  name: string | undefined,
): PrivacyLevel[] {
  const spec = channels.find((channel) => channel.name === name);
  if (spec?.privacy === undefined) return [];
  return [level('channel', `channel '${spec.name}'`, spec.privacy)];
}

/** `channel:<name>` for every declared channel that sets `privacy`. */
export function channelScopes(channels: readonly ChannelSpec[]): PrivacyScopes {
  const scopes: Record<string, PrivacyScope> = {};
  for (const spec of channels) {
    if (spec.privacy !== undefined) {
      scopes[`channel:${spec.name}`] = { levels: channelLevels(channels, spec.name) };
    }
  }
  return scopes;
}

/** The durable scope of an activator: channel, then `ActivatorOptions.privacy`. */
export function activatorPrivacyScope(
  channels: readonly ChannelSpec[],
  name: string,
  metadata: ActivatorMetadata,
): PrivacyScope {
  const own = level('activator', `activator '${name}'`, metadata.privacy);
  return { levels: [...channelLevels(channels, metadata.channel), own], durable: true };
}

/**
 * The durable scope of an inbound endpoint (6.6): `InboundDefaults.privacy`, channel,
 * `InboundSpec.privacy`, then the endpoint's `idempotency.remember`.
 */
export function inboundPrivacyScope(
  channels: readonly ChannelSpec[],
  spec: InboundSpec,
  defaults: InboundDefaults | undefined,
): PrivacyScope {
  const { remember, onDuplicate } = idempotencyOf(spec, defaults);
  const subject = subjectOf(spec);
  return {
    levels: [
      level('defaults', 'inbound defaults', defaults?.privacy),
      ...channelLevels(channels, spec.channel),
      level('endpoint', subject, withRemember(spec.privacy, remember)),
    ],
    durable: true,
    replays: spec.requestReply === true && onDuplicate === 'replay' && spec.idempotency !== false,
  };
}

/**
 * 6.6: endpoints that feed one channel share its `inbound:<channel>` scope, so they must declare
 * the same privacy and `remember`. One error finding per channel whose endpoints differ; its
 * problem names the handlers only. The scope replays when any of those endpoints replays, so
 * `OUTCOME_ONLY_REPLAY` covers every endpoint. Endpoints that all declare none never conflict.
 */
export function inboundChannelScopes(
  channels: readonly ChannelSpec[],
  inbounds: readonly { spec: InboundSpec; handler: string }[],
  defaults: InboundDefaults | undefined,
): { scopes: Record<string, PrivacyScope>; findings: PrivacyFinding[]; problems: string[] } {
  const first = new Map<string, { handler: string; scope: PrivacyScope }>();
  const scopes: Record<string, PrivacyScope> = {};
  const findings: PrivacyFinding[] = [];
  const problems: string[] = [];
  for (const { spec, handler } of inbounds) {
    const name = `inbound:${spec.channel}`;
    const scope = inboundPrivacyScope(channels, spec, defaults);
    const seen = first.get(spec.channel);
    if (seen === undefined) {
      first.set(spec.channel, { handler, scope });
      scopes[name] = scope;
      continue;
    }
    if (scope.replays === true) scopes[name] = { ...scopes[name]!, replays: true };
    if (sameLevels(seen.scope, scope) || findings.some((f) => f.subject === subjectOf(spec))) {
      continue;
    }
    findings.push({
      code: PRIVACY_FINDING_CODES.INBOUND_SCOPE_CONFLICT,
      severity: 'error',
      subject: subjectOf(spec),
      path: 'privacy',
    });
    problems.push(
      `${subjectOf(spec)}: endpoints ${seen.handler} and ${handler} declare different privacy ` +
        'or remember for one channel',
    );
  }
  return { scopes, findings, problems };
}

function subjectOf(spec: InboundSpec): string {
  return `inbound '${spec.channel}'`;
}

function sameLevels(a: PrivacyScope, b: PrivacyScope): boolean {
  if (a.levels.length !== b.levels.length) return false;
  return a.levels.every((level, i) => sameValue(level.ref, b.levels[i]?.ref));
}

/** Structural equality of references: plain data by value, regexes by source, functions by identity. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** The endpoint's `remember` and `onDuplicate` over the module inbound defaults. */
function idempotencyOf(
  spec: InboundSpec,
  defaults: InboundDefaults | undefined,
): {
  remember: InboundIdempotencyOptions['remember'] | undefined;
  onDuplicate: InboundIdempotencyOptions['onDuplicate'] | undefined;
} {
  const endpoint = spec.idempotency === false ? undefined : spec.idempotency;
  const moduleDefault = defaults?.idempotency === false ? undefined : defaults?.idempotency;
  return {
    remember: endpoint?.remember ?? moduleDefault?.remember,
    onDuplicate: endpoint?.onDuplicate ?? moduleDefault?.onDuplicate,
  };
}

type RefObject = Exclude<PrivacyRef, string | readonly string[]>;

/** A reference as an object, so `remember` can join it. */
function refObject(ref: PrivacyRef | undefined): RefObject {
  if (ref === undefined) return {};
  if (typeof ref === 'string' || Array.isArray(ref)) return { use: ref as string | string[] };
  return ref as RefObject;
}

/** `idempotency.remember` joins the endpoint reference, so its `rememberReason` sits next to it. */
export function withRemember(
  ref: PrivacyRef | undefined,
  remember: Remember | undefined,
): PrivacyRef | undefined {
  return remember === undefined ? ref : { ...refObject(ref), remember };
}

/**
 * SD-44: an endpoint that boot discovery skipped gets its privacy scope at its first plan build;
 * a problem fails that request before any claim and is logged once per endpoint.
 */
export function inboundPrivacyGuard(
  privacy: PrivacyEngine,
  channels: readonly ChannelSpec[],
  defaults: InboundDefaults | undefined,
  logger: PrivacyLogger = nestPrivacyLogger(),
): (spec: InboundSpec) => void {
  const logged = new Set<string>();
  return (spec) => {
    const scope = `inbound:${spec.channel}`;
    if (privacy.off || privacy.hasScope(scope)) return;
    try {
      addPrivacyScopes(privacy, { [scope]: inboundPrivacyScope(channels, spec, defaults) });
    } catch (error) {
      if (!logged.has(scope) && error instanceof PrivacyConfigError) {
        logged.add(scope);
        logger.error(`privacy: ${scope} refused: ${error.message}`);
      }
      throw error;
    }
  };
}

/** Adds scopes found at boot; throws one PrivacyConfigError with every finding (SD-37). */
export function addPrivacyScopes(
  engine: PrivacyEngine,
  scopes: PrivacyScopes,
  extra: { sealKeys?: boolean } = {},
): void {
  if (Object.keys(scopes).length === 0) return;
  const result = engine.addScopes(scopes, extra);
  if (result.findings.length > 0) throw new PrivacyConfigError(result.problems, result.findings);
}

const FLOW_EDGES: ReadonlySet<CareEdge> = new Set(['flow-handle', 'flow-send', 'flow-jump']);

/**
 * SD-62: where a care event's text is shown, by its subject. An activator's binding is its privacy
 * scope; an outbound REST binding's is `outbound:<name>`; a flow step's is `flow:<flow>#<id>`, and a
 * target's own scope adds `:<channel>`, so a target without one falls back to its step. Every other
 * edge, and an unknown scope, falls back to the event channel and then to the module.
 */
export function careEventTrail(
  event: Pick<CareEvent, 'edge' | 'binding' | 'channel'>,
  engine: Pick<PrivacyEngine, 'hasScope'>,
): { scope?: string; channel?: string } {
  const where: { scope?: string; channel?: string } = {};
  if (event.channel !== undefined) where.channel = event.channel;
  if (event.edge === 'activator') where.scope = event.binding;
  else if (event.edge === 'outbound-rest') where.scope = `outbound:${event.binding}`;
  else if (FLOW_EDGES.has(event.edge)) {
    const suffix = event.channel === undefined ? undefined : `:${event.channel}`;
    const step =
      suffix !== undefined && event.binding.endsWith(suffix)
        ? event.binding.slice(0, -suffix.length)
        : event.binding;
    where.scope = engine.hasScope(event.binding) ? event.binding : step;
  }
  return where;
}
