import type { PrivacyLevel, PrivacyScope, PrivacyScopes } from '../sensitive/policy-resolver';
import { PrivacyEngine } from '../sensitive/privacy-engine';
import { PrivacyConfigError } from '../sensitive/privacy-errors';
import type { PrivacyRef } from '../sensitive/privacy.types';

/** What the gateway needs to resolve binding and call privacy (SPI-433, 18.2). */
export interface OutboundPrivacyDeps {
  /** The module engine; a standalone gateway uses the baseline engine. */
  engine: PrivacyEngine;
  /** L2 level of a bound channel; none when the channel declares no privacy. */
  channelLevels?: (channel: string) => readonly PrivacyLevel[];
}

/** The references of one binding: its name, bound channel and L4 levels. */
export interface OutboundBindingRefs {
  name: string;
  channel?: string;
  /** `outbound.rest.defaults.privacy`. */
  defaults?: PrivacyRef;
  /** `OutboundRestOptions.privacy` of the binding. */
  privacy?: PrivacyRef;
}

/**
 * The references of a binding as written: its name (`name`, else the channel) and its own and the
 * module default `privacy`. Undefined when it has no name; declaring it fails with its own error.
 */
export function bindingRefsOf(
  binding: { name?: string; channel?: string; privacy?: PrivacyRef },
  defaults: PrivacyRef | undefined,
): OutboundBindingRefs | undefined {
  const name = binding.name ?? binding.channel;
  if (name === undefined || name.length === 0) return undefined;
  const refs: OutboundBindingRefs = { name };
  if (binding.channel !== undefined) refs.channel = binding.channel;
  if (defaults !== undefined) refs.defaults = defaults;
  if (binding.privacy !== undefined) refs.privacy = binding.privacy;
  return refs;
}

/** An inline policy, remembered by identity; names and lists are remembered by value. */
function inlineOf(ref: PrivacyRef): object | undefined {
  return typeof ref === 'object' && !Array.isArray(ref) ? ref : undefined;
}

/** Scope name of a declared outbound REST binding. */
export function outboundScopeName(name: string): string {
  return `outbound:${name}`;
}

/**
 * Scope of an outbound REST binding (6.6): module, bound channel, binding (module defaults
 * first). Boot prints its line only when an explicit privacy reaches it.
 */
export function outboundPrivacyScope(
  refs: OutboundBindingRefs,
  channelLevels: OutboundPrivacyDeps['channelLevels'],
): PrivacyScope {
  const channel =
    refs.channel === undefined || channelLevels === undefined ? [] : channelLevels(refs.channel);
  const levels: PrivacyLevel[] = [
    ...channel,
    { kind: 'binding', subject: 'outbound rest defaults', ref: refs.defaults },
    { kind: 'binding', subject: `outbound rest '${refs.name}'`, ref: refs.privacy },
  ];
  return { levels, summary: 'explicit' };
}

function throwFindings(result: ReturnType<PrivacyEngine['checkScopes']>): void {
  if (result.findings.length > 0) throw new PrivacyConfigError(result.problems, result.findings);
}

/**
 * Binding (L4) and call (L5) privacy of one gateway. Binding scopes are added once, at boot or
 * when a binding is declared; a call reference is checked on the first call that carries it,
 * before the request is sent, and only valid references are remembered (SD-56).
 */
export class OutboundPrivacy {
  private readonly checked = new WeakMap<object, { names: Set<string>; inline: WeakSet<object> }>();

  constructor(private readonly deps: OutboundPrivacyDeps = { engine: PrivacyEngine.baseline() }) {}

  /** Adds the scope of a declared binding unless the boot resolver already did. */
  declare(refs: OutboundBindingRefs): void {
    const scope = outboundScopeName(refs.name);
    if (this.deps.engine.hasScope(scope)) return;
    const scopes: PrivacyScopes = { [scope]: outboundPrivacyScope(refs, this.deps.channelLevels) };
    throwFindings(this.deps.engine.addScopes(scopes));
  }

  /** SD-59: the graph names of a binding; undefined when no reference reaches it. */
  graphNames(refs: OutboundBindingRefs): string[] | undefined {
    return this.deps.engine.graphNames(outboundPrivacyScope(refs, this.deps.channelLevels));
  }

  /** Checks an ad-hoc binding's references without keeping a scope. */
  checkAdHoc(refs: OutboundBindingRefs): void {
    if (refs.defaults === undefined && refs.privacy === undefined) return;
    const scope = outboundPrivacyScope(refs, this.deps.channelLevels);
    throwFindings(this.deps.engine.checkScopes({ [outboundScopeName(refs.name)]: scope }));
  }

  /**
   * SD-56: the call reference against the frozen profile registry, unioned over its binding.
   * `owner` is the binding plan; a valid reference is not checked again for it.
   */
  checkCall(owner: object, refs: OutboundBindingRefs, ref: PrivacyRef | undefined): void {
    if (ref === undefined) return;
    const inline = inlineOf(ref);
    const key = inline === undefined ? JSON.stringify(ref) : '';
    let seen = this.checked.get(owner);
    if (inline === undefined ? seen?.names.has(key) : seen?.inline.has(inline)) return;
    const scope = outboundPrivacyScope(refs, this.deps.channelLevels);
    const call: PrivacyLevel = { kind: 'call', subject: `outbound rest '${refs.name}' call`, ref };
    const name = `${outboundScopeName(refs.name)}#call`;
    throwFindings(
      this.deps.engine.checkScopes({ [name]: { ...scope, levels: [...scope.levels, call] } }),
    );
    if (seen === undefined) {
      seen = { names: new Set(), inline: new WeakSet() };
      this.checked.set(owner, seen);
    }
    if (inline === undefined) seen.names.add(key);
    else seen.inline.add(inline);
  }
}
