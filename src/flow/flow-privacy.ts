import type { IntegrationMessage, MessageHeaders } from '../message';
import type { PrivacyLevel, PrivacyScope, PrivacyScopes } from '../sensitive/policy-resolver';
import type { PrivacyEngine, PrivacyLogger } from '../sensitive/privacy-engine';
import { TrailOutput } from '../sensitive/privacy-engine';
import { PRIVACY_FINDING_CODES, type PrivacyFinding } from '../sensitive/privacy-errors';
import { envelopeBody, envelopeError, storedError } from '../trace/trail';
import {
  TapCopy,
  type FlowStep,
  type FlowStepKind,
  type FlowTarget,
  type StepTrailPort,
} from './flow-step';
import { stepIdOf, type BuiltFlow } from './integration-flow';
import { WireTapStep } from './steps/wire-tap.step';

/** Channel levels by channel name (L2), from the module's channel declarations. */
export type ChannelPrivacyLevels = (channel: string) => PrivacyLevel[];

const REASON_MAX = 200;

/** Steps whose subject unions the destination channels and the target levels (18.2). */
const SEND_KINDS: ReadonlySet<FlowStepKind> = new Set(['to', 'publish', 'route', 'fanout', 'jump']);

const flowScope = (flow: string): string => `flow:${flow}`;
const stepScope = (flow: string, id: string): string => `flow:${flow}#${id}`;
const stepSubject = (flow: string, id: string): string => `flow '${flow}' step '${id}'`;

/** Where the subjects of one step live, by scope name. */
interface StepLayout {
  readonly id: string;
  /** `flow:<flow>#<stepId>`: every sink of the step and the flow sinks when it fails. */
  readonly scope: string;
  readonly levels: readonly PrivacyLevel[];
  /** Scope of each `wait: false` target, by target index; siblings never share one (SD-47). */
  readonly targets: ReadonlyMap<number, { scope: string; levels: readonly PrivacyLevel[] }>;
  /** `route` only: the levels of one run-time target channel (SD-55). */
  readonly routeLevels?: (channel: string) => PrivacyLevel[];
}

/** Destinations of a send step: its static targets, else the channel its graph entry names. */
function targetsOf(step: FlowStep): readonly FlowTarget[] {
  const targets = step.params?.targets;
  if (targets !== undefined) return targets;
  const channel = step.describe().channel;
  return typeof channel === 'string' ? [{ channel }] : [];
}

function flowLevel(name: string, built: BuiltFlow): PrivacyLevel {
  return { kind: 'flow', subject: `flow '${name}'`, ref: built.options?.privacy };
}

/**
 * The subjects of every step of a flow (18.2). A non-send step unions the source channel, the
 * flow and the step; a send step adds every destination channel and target level (the source too,
 * D18); a wire tap unions the tap channel, the source channel, the flow and the step (D20).
 */
function layoutOf(name: string, built: BuiltFlow, levelsOf: ChannelPrivacyLevels): StepLayout[] {
  const source = levelsOf(built.source);
  const flow = flowLevel(name, built);
  return built.steps.map((step, index) => {
    const id = stepIdOf(step, index);
    const subject = stepSubject(name, id);
    const own: PrivacyLevel = {
      kind: 'step',
      subject,
      ref: step.params?.privacy,
      stepKind: step.kind,
    };
    const scope = stepScope(name, id);
    const targets = new Map<number, { scope: string; levels: readonly PrivacyLevel[] }>();
    if (step instanceof WireTapStep) {
      const levels = [...levelsOf(step.channel), ...source, flow, own];
      return { id, scope, levels, targets };
    }
    if (!SEND_KINDS.has(step.kind)) return { id, scope, levels: [...source, flow, own], targets };
    const dests = targetsOf(step);
    const targetLevel = (target: FlowTarget): PrivacyLevel => ({
      kind: 'target',
      subject: `${subject} target '${target.channel}'`,
      ref: target.privacy,
      stepKind: step.kind,
    });
    const channels = [...new Set(dests.map((target) => target.channel))];
    const levels = [...source, ...channels.flatMap(levelsOf), flow, own, ...dests.map(targetLevel)];
    const used = new Set<string>();
    for (const [at, target] of dests.entries()) {
      if (target.wait !== false) continue;
      const base = `${scope}:${target.channel}`;
      const targetScope = used.has(base) ? `${base}~${at}` : base;
      used.add(base);
      const targetLevels = [...source, ...levelsOf(target.channel), flow, own, targetLevel(target)];
      targets.set(at, { scope: targetScope, levels: targetLevels });
    }
    const layout: StepLayout = { id, scope, levels, targets };
    if (step.kind !== 'route') return layout;
    return {
      ...layout,
      routeLevels: (channel) => [...source, ...levelsOf(channel), flow, own],
    };
  });
}

/**
 * Privacy scopes of one flow (18.2, SD-45..SD-47): `flow:<flow>` (source channel and flow, L2 and
 * L3), one `flow:<flow>#<stepId>` per step and one internal scope per `wait: false` target. Flow
 * and step scopes print a boot line only under explicit privacy (SD-60); target scopes never do.
 */
export function flowPrivacyScopes(
  name: string,
  built: BuiltFlow,
  levelsOf: ChannelPrivacyLevels,
): PrivacyScopes {
  const scopes: Record<string, PrivacyScope> = {};
  scopes[flowScope(name)] = {
    levels: [...levelsOf(built.source), flowLevel(name, built)],
    summary: 'explicit',
  };
  for (const layout of layoutOf(name, built, levelsOf)) {
    scopes[layout.scope] = { levels: layout.levels, summary: 'explicit' };
    for (const target of layout.targets.values()) {
      scopes[target.scope] = { levels: target.levels, summary: 'none' };
    }
  }
  return scopes;
}

interface TapPlan {
  readonly scope: string;
  readonly shown: boolean;
}

/** Boot result of a flow: its trail writers, findings and boot lines. */
export interface FlowPrivacyResolution {
  readonly privacy: FlowPrivacy | undefined;
  readonly findings: readonly PrivacyFinding[];
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

/** What a flow's trail writers need besides the engine. */
export interface FlowPrivacyEnv {
  readonly levelsOf: ChannelPrivacyLevels;
  /** True for a channel the registry knows; a `route` caches plans for those only (SD-55). */
  readonly isRegistered: (channel: string) => boolean;
  /** Logger of the run-time `route` scopes' notes; they print no summary line. */
  readonly logger?: PrivacyLogger;
}

/**
 * Resolves the trail writers of a flow once its scopes are compiled: the failing step subject of
 * the flow sinks (SD-45) and the wire-tap copies (SD-28, SD-52), hidden by default under explicit
 * privacy, where `TapCopy.Original` needs a logged `copyReason`.
 */
export function resolveFlowPrivacy(
  engine: PrivacyEngine,
  name: string,
  built: BuiltFlow,
  env: FlowPrivacyEnv,
): FlowPrivacyResolution {
  const findings: PrivacyFinding[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const layouts = layoutOf(name, built, env.levelsOf);
  const taps = new Map<number, TapPlan>();
  for (const [index, step] of built.steps.entries()) {
    if (!(step instanceof WireTapStep)) continue;
    const { scope, id } = layouts[index]!;
    const explicit = engine.reaches({ scope });
    const { copy, copyReason } = step.tap;
    const subject = stepSubject(name, id);
    if (copy === TapCopy.Original && explicit) {
      if (!isReason(copyReason)) {
        findings.push({
          code: PRIVACY_FINDING_CODES.COPY_REASON_MISSING,
          severity: 'error',
          subject,
          path: 'copyReason',
        });
        problems.push(`${subject}: copyReason must be 1..${REASON_MAX} chars for TapCopy.Original`);
        continue;
      }
      notes.push(`privacy original-copy tap: ${subject} reason: ${copyReason}`);
    }
    const shown = copy === TapCopy.AsShown || (copy === undefined && explicit);
    taps.set(index, { scope, shown });
  }
  if (engine.off) return { privacy: undefined, findings, problems, notes };
  const privacy = new FlowPrivacy(engine, name, layouts, taps, env);
  return { privacy, findings, problems, notes };
}

function isReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= REASON_MAX;
}

/** Trail writers of one flow: error envelope, stored failure and per-step ports. */
export class FlowPrivacy {
  private readonly ports = new Map<number, StepTrailPort>();
  /** The channel a `route` send failed on, by the error it threw. */
  private readonly routed = new WeakMap<object, string>();
  /** Run-time `route` target scopes, by step index and registered channel (SD-55). */
  private readonly routeScopes = new Map<number, Map<string, string>>();

  constructor(
    private readonly engine: PrivacyEngine,
    private readonly name: string,
    private readonly layouts: readonly StepLayout[],
    private readonly taps: ReadonlyMap<number, TapPlan>,
    private readonly env: FlowPrivacyEnv,
  ) {}

  /**
   * S4: the flow envelope's `error`, shown with the failing step's subject (SD-45); the raw error
   * unless an explicit privacy reaches it. `step` is the index of the failing step.
   */
  envelopeError(error: unknown, step?: number): unknown {
    return envelopeError(this.engine, error, { scope: this.failureScope(error, step) });
  }

  /** S8: the error a flow `fail` record keeps (7.3), with the failing step's subject. */
  storedError(error: unknown, step?: number): unknown {
    return storedError(this.engine, error, { scope: this.failureScope(error, step) });
  }

  step(index: number): StepTrailPort {
    let port = this.ports.get(index);
    if (port === undefined) {
      port = this.portOf(index);
      this.ports.set(index, port);
    }
    return port;
  }

  private failureScope(error: unknown, step: number | undefined): string {
    const layout = step === undefined ? undefined : this.layouts[step];
    if (layout === undefined || step === undefined) return flowScope(this.name);
    const channel =
      typeof error === 'object' && error !== null ? this.routed.get(error) : undefined;
    if (channel === undefined) return layout.scope;
    return this.routeScope(step, layout, channel) ?? layout.scope;
  }

  /** One plan per registered channel, resolved at its first failure (SD-55, 18.5). */
  private routeScope(step: number, layout: StepLayout, channel: string): string | undefined {
    if (layout.routeLevels === undefined || !this.env.isRegistered(channel)) return undefined;
    let cache = this.routeScopes.get(step);
    if (cache === undefined) {
      cache = new Map();
      this.routeScopes.set(step, cache);
    }
    const cached = cache.get(channel);
    if (cached !== undefined) return cached;
    const scope = `${layout.scope}:${channel}`;
    const added = this.engine.addScopes(
      { [scope]: { levels: layout.routeLevels(channel), summary: 'none' } },
      this.env.logger === undefined ? {} : { logger: this.env.logger },
    );
    // Boot validated every reference, so a finding here cannot happen; the step subject stays.
    const resolved = added.findings.length === 0 ? scope : layout.scope;
    cache.set(channel, resolved);
    return resolved;
  }

  private portOf(index: number): StepTrailPort {
    const engine = this.engine;
    const layout = this.layouts[index];
    const scope = layout?.scope ?? flowScope(this.name);
    const tap = this.taps.get(index);
    return {
      envelopeBody: (body, target) =>
        envelopeBody(engine, body, { scope: layout?.targets.get(target)?.scope ?? scope }),
      tapCopy: (msg) => (tap?.shown === true ? shownCopy(engine, tap.scope, msg) : undefined),
      routeFailed: (error, channel) => {
        if (typeof error === 'object' && error !== null) this.routed.set(error, channel);
      },
    };
  }
}

/** SD-28: same id, copied history, hidden payload and headers (trace fields stay intact). */
function shownCopy(
  engine: PrivacyEngine,
  scope: string,
  msg: IntegrationMessage,
): IntegrationMessage {
  const shown = engine.forTrail(
    { payload: msg.payload, headers: msg.headers },
    { output: TrailOutput.WireTap, scope },
  ) as { payload?: unknown; headers?: MessageHeaders } | string;
  if (typeof shown !== 'object') {
    return { payload: shown, headers: { ...msg.headers, history: [...msg.headers.history] } };
  }
  const headers = { ...(shown.headers ?? msg.headers) };
  return { payload: shown.payload, headers: { ...headers, history: [...msg.headers.history] } };
}
