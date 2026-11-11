import type { IntegrationMessage, MessageHeaders } from '../message';
import type { PrivacyLevel, PrivacyScope, PrivacyScopes } from '../sensitive/policy-resolver';
import type { PrivacyEngine, PrivacyLogger } from '../sensitive/privacy-engine';
import { TrailOutput } from '../sensitive/privacy-engine';
import { PRIVACY_FINDING_CODES, type PrivacyFinding } from '../sensitive/privacy-errors';
import { PROTECTED_TRACE_FIELDS, Reach, type PrivacyRef } from '../sensitive/privacy.types';
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

/** Send steps with several targets: each target's hop copy has its own scope (SD-47, SD-50). */
const MULTI_KINDS: ReadonlySet<FlowStepKind> = new Set(['fanout', 'jump']);

/** Only an inline reference carries `reach` (profiles cannot). */
function deliveryReach(ref: PrivacyRef | false | undefined): boolean {
  return (
    typeof ref === 'object' &&
    !Array.isArray(ref) &&
    (ref as { reach?: unknown }).reach === Reach.Delivery
  );
}

const flowScope = (flow: string): string => `flow:${flow}`;
const stepScope = (flow: string, id: string): string => `flow:${flow}#${id}`;
const stepSubject = (flow: string, id: string): string => `flow '${flow}' step '${id}'`;
const replyScopeName = (scope: string, channel: string): string =>
  `${scope}:jumpReplies:${channel}`;

/** Where the subjects of one step live, by scope name. */
interface StepLayout {
  readonly id: string;
  /** `flow:<flow>#<stepId>`: every sink of the step and the flow sinks when it fails. */
  readonly scope: string;
  readonly levels: readonly PrivacyLevel[];
  /**
   * Scope of each `wait: false` or delivery-reach target of `fanoutTo`/`jumpTo`, by target index;
   * siblings never share one (SD-47, SD-50).
   */
  readonly targets: ReadonlyMap<number, ScopedLevels>;
  /** Wire tap only: one scope per `jumpReplies` channel this flow jumps to (SD-53). */
  readonly replies?: ReadonlyMap<string, ScopedLevels>;
  /** Wire tap only: the levels of the tap copy, for a `jumpReplies` channel met at run time. */
  readonly tapLevels?: readonly PrivacyLevel[];
  /** `route` only: the levels of one run-time target channel (SD-55). */
  readonly routeLevels?: (channel: string) => PrivacyLevel[];
  /** `fanoutTo`/`jumpTo` only: the levels of each target's hop, by target index (SD-59). */
  readonly destLevels?: readonly (readonly PrivacyLevel[])[];
}

/** Destinations of a send step: its static targets, else the channel its graph entry names. */
function targetsOf(step: FlowStep): readonly FlowTarget[] {
  const targets = step.params?.targets;
  if (targets !== undefined) return targets;
  const channel = step.describe().channel;
  return typeof channel === 'string' ? [{ channel }] : [];
}

/**
 * The levels of each channel the steps before `upTo` jump to: the jump step and that target
 * (SD-53). A channel jumped to twice unions both.
 */
function jumpLevels(name: string, built: BuiltFlow, upTo: number): Map<string, PrivacyLevel[]> {
  const out = new Map<string, PrivacyLevel[]>();
  for (const [index, step] of built.steps.slice(0, upTo).entries()) {
    if (step.kind !== 'jump') continue;
    const subject = stepSubject(name, stepIdOf(step, index));
    const own: PrivacyLevel = {
      kind: 'step',
      subject,
      ref: step.params?.privacy,
      stepKind: 'jump',
    };
    for (const target of targetsOf(step)) {
      const levels = out.get(target.channel) ?? [];
      levels.push(own, {
        kind: 'target',
        subject: `${subject} target '${target.channel}'`,
        ref: target.privacy,
        stepKind: 'jump',
      });
      out.set(target.channel, levels);
    }
  }
  return out;
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
    const own: PrivacyLevel = {
      kind: 'step',
      subject: stepSubject(name, id),
      ref: step.params?.privacy,
      stepKind: step.kind,
    };
    const scope = stepScope(name, id);
    if (step instanceof WireTapStep) {
      const levels = [...levelsOf(step.channel), ...source, flow, own];
      const replies = new Map<string, ScopedLevels>();
      for (const [channel, jumps] of jumpLevels(name, built, index)) {
        const replyLevels = [...levels, ...levelsOf(channel), ...jumps];
        replies.set(channel, { scope: replyScopeName(scope, channel), levels: replyLevels });
      }
      return { id, scope, levels, targets: new Map(), replies, tapLevels: levels };
    }
    if (!SEND_KINDS.has(step.kind)) {
      return { id, scope, levels: [...source, flow, own], targets: new Map() };
    }
    return sendLayout({ id, scope, step, own, source, flow, levelsOf });
  });
}

interface ScopedLevels {
  readonly scope: string;
  readonly levels: readonly PrivacyLevel[];
}

interface SendInput {
  readonly id: string;
  readonly scope: string;
  readonly step: FlowStep;
  readonly own: PrivacyLevel;
  readonly source: readonly PrivacyLevel[];
  readonly flow: PrivacyLevel;
  readonly levelsOf: ChannelPrivacyLevels;
}

/** A send step: destination channels and target levels; own scopes per target where needed. */
function sendLayout(input: SendInput): StepLayout {
  const { id, scope, step, own, source, flow, levelsOf } = input;
  const dests = targetsOf(step);
  const targetLevel = (target: FlowTarget): PrivacyLevel => ({
    kind: 'target',
    subject: `${own.subject} target '${target.channel}'`,
    ref: target.privacy,
    stepKind: step.kind,
  });
  const channels = [...new Set(dests.map((target) => target.channel))];
  const levels = [...source, ...channels.flatMap(levelsOf), flow, own, ...dests.map(targetLevel)];
  const targets = new Map<number, ScopedLevels>();
  const used = new Set<string>();
  const hopLevels = (target: FlowTarget): PrivacyLevel[] => [
    ...source,
    ...levelsOf(target.channel),
    flow,
    own,
    targetLevel(target),
  ];
  for (const [at, target] of dests.entries()) {
    if (!ownScope(step, target)) continue;
    const base = `${scope}:${target.channel}`;
    const targetScope = used.has(base) ? `${base}~${at}` : base;
    used.add(base);
    targets.set(at, { scope: targetScope, levels: hopLevels(target) });
  }
  const layout: StepLayout = { id, scope, levels, targets };
  if (MULTI_KINDS.has(step.kind)) return { ...layout, destLevels: dests.map(hopLevels) };
  if (step.kind !== 'route') return layout;
  return { ...layout, routeLevels: (channel) => [...source, ...levelsOf(channel), flow, own] };
}

/**
 * A target gets its own scope for its `wait: false` envelope (SD-47) or, on `fanoutTo`/`jumpTo`,
 * for a delivery-reach hop copy of the step or the target (SD-50).
 */
function ownScope(step: FlowStep, target: FlowTarget): boolean {
  if (target.wait === false) return true;
  if (!MULTI_KINDS.has(step.kind)) return false;
  return deliveryReach(step.params?.privacy) || deliveryReach(target.privacy);
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
    for (const target of [...layout.targets.values(), ...(layout.replies?.values() ?? [])]) {
      scopes[target.scope] = { levels: target.levels, summary: 'none' };
    }
  }
  return scopes;
}

/** SD-59: a flow's graph entry with its privacy names. */
export interface FlowGraphPrivacy {
  /** Each step's graph entry; a step a reference reaches gets `privacy` and its `id`. */
  readonly steps: readonly Record<string, unknown>[];
  /** Present when the flow sets `privacy` (L3): the names that reach the flow sinks. */
  readonly options?: { privacy: string[] };
}

/**
 * SD-59: profile names, pack names with version and 'inline' on the graph entry of a flow, its
 * steps and the dests of `fanoutTo`/`jumpTo`. A key appears only where a reference reaches; the
 * step `id` comes with it (RS-66). Rules, paths and reasons never reach the graph.
 */
export function flowGraphPrivacy(
  engine: PrivacyEngine,
  name: string,
  built: BuiltFlow,
  described: readonly Record<string, unknown>[],
  levelsOf: ChannelPrivacyLevels,
): FlowGraphPrivacy {
  const layouts = layoutOf(name, built, levelsOf);
  const steps = described.map((base, index) => {
    const layout = layouts[index];
    const privacy = layout === undefined ? undefined : engine.graphNames({ levels: layout.levels });
    if (layout === undefined || privacy === undefined) return base;
    const out: Record<string, unknown> = { kind: base.kind, id: layout.id, ...base };
    if (Array.isArray(base.dests) && layout.destLevels !== undefined) {
      const destLevels = layout.destLevels;
      out.dests = (base.dests as Record<string, unknown>[]).map((dest, at) => {
        const levels = destLevels[at];
        const names = levels === undefined ? undefined : engine.graphNames({ levels });
        return names === undefined ? dest : { ...dest, privacy: names };
      });
    }
    out.privacy = privacy;
    return out;
  });
  if (built.options?.privacy === undefined) return { steps };
  const options = engine.graphNames({
    levels: [...levelsOf(built.source), flowLevel(name, built)],
  });
  return options === undefined ? { steps } : { steps, options: { privacy: options } };
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
  /**
   * Scopes resolved at run time, by step index and registered channel: `route` targets (SD-55)
   * and `jumpReplies` channels a tap copy meets that this flow does not jump to (SD-53).
   */
  private readonly lateScopes = new Map<number, Map<string, string>>();

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
    const levels = layout.routeLevels;
    if (levels === undefined) return undefined;
    return this.lateScope(step, layout, channel, `${layout.scope}:${channel}`, () =>
      levels(channel),
    );
  }

  /** SD-53: the scope of `jumpReplies[channel]` in the tap copy of step `step`. */
  private replyScope(step: number, layout: StepLayout, channel: string): string {
    const known = layout.replies?.get(channel);
    if (known !== undefined) return known.scope;
    const tap = layout.tapLevels ?? layout.levels;
    const scope = replyScopeName(layout.scope, channel);
    const late = this.lateScope(step, layout, channel, scope, () => [
      ...tap,
      ...this.env.levelsOf(channel),
    ]);
    return late ?? layout.scope;
  }

  private lateScope(
    step: number,
    layout: StepLayout,
    channel: string,
    scope: string,
    levels: () => PrivacyLevel[],
  ): string | undefined {
    if (!this.env.isRegistered(channel)) return undefined;
    let cache = this.lateScopes.get(step);
    if (cache === undefined) {
      cache = new Map();
      this.lateScopes.set(step, cache);
    }
    const cached = cache.get(channel);
    if (cached !== undefined) return cached;
    const added = this.engine.addScopes(
      { [scope]: { levels: levels(), summary: 'none' } },
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
      tapCopy: (msg) => {
        if (tap?.shown !== true || layout === undefined) return undefined;
        return shownCopy(engine, tap.scope, msg, (channel) =>
          this.replyScope(index, layout, channel),
        );
      },
      routeFailed: (error, channel) => {
        if (typeof error === 'object' && error !== null) this.routed.set(error, channel);
      },
      deliver: (msg, target) => {
        // Every delivery-reach target of fanoutTo/jumpTo has its own scope; the step scope
        // unions all of them, so a target without one gets the message as it is.
        const delivery = target === undefined ? scope : layout?.targets.get(target)?.scope;
        if (delivery === undefined || !engine.delivers(delivery)) return msg;
        return deliveredCopy(engine, delivery, msg);
      },
    };
  }
}

/**
 * SD-50, SD-51: the payload and each `jumpReplies` value through the scope's delivery-reach
 * rules; other headers are untouched and unchanged parts keep their reference.
 */
function deliveredCopy(
  engine: PrivacyEngine,
  scope: string,
  msg: IntegrationMessage,
): IntegrationMessage {
  const payload = engine.forDelivery(msg.payload, scope);
  const replies = msg.headers.jumpReplies;
  let delivered = replies;
  if (replies !== undefined) {
    const out: Record<string, unknown> = {};
    for (const [channel, value] of Object.entries(replies)) {
      out[channel] = engine.forDelivery(value, scope);
      if (out[channel] !== value) delivered = out;
    }
  }
  if (payload === msg.payload && delivered === replies) return msg;
  if (delivered === replies || delivered === undefined) return { payload, headers: msg.headers };
  return { payload, headers: { ...msg.headers, jumpReplies: delivered } };
}

/**
 * SD-53: each `jumpReplies` value shown as a payload, with the tap's policy united with the
 * jumped channel and that jump's privacy. Keys are channel names and are kept.
 */
function shownReplies(
  engine: PrivacyEngine,
  replies: Readonly<Record<string, unknown>>,
  scopeOf: (channel: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [channel, value] of Object.entries(replies)) {
    const shown = engine.forTrail(
      { payload: value },
      { output: TrailOutput.WireTap, scope: scopeOf(channel) },
    );
    out[channel] =
      typeof shown === 'object' && shown !== null
        ? (shown as { payload?: unknown }).payload
        : shown;
  }
  return out;
}

/** SD-28: same id, copied history, hidden payload and headers (trace fields stay intact). */
function shownCopy(
  engine: PrivacyEngine,
  scope: string,
  msg: IntegrationMessage,
  replyScope: (channel: string) => string,
): IntegrationMessage {
  const { jumpReplies, ...rest } = msg.headers;
  const own = jumpReplies === undefined ? msg.headers : (rest as MessageHeaders);
  const shown = engine.forTrail(
    { payload: msg.payload, headers: own },
    { output: TrailOutput.WireTap, scope },
  ) as { payload?: unknown; headers?: MessageHeaders } | string;
  const history = [...msg.headers.history];
  const replies =
    jumpReplies === undefined ? {} : { jumpReplies: shownReplies(engine, jumpReplies, replyScope) };
  // SD-23: when hiding fails, the copy keeps only the trace fields, never a raw header.
  const headers = typeof shown === 'object' ? shown.headers : undefined;
  const payload = typeof shown === 'object' ? shown.payload : shown;
  return { payload, headers: { ...(headers ?? traceOnly(own)), ...replies, history } };
}

function traceOnly(headers: MessageHeaders): MessageHeaders {
  const kept: Record<string, unknown> = {};
  for (const field of PROTECTED_TRACE_FIELDS) {
    if (headers[field] !== undefined) kept[field] = headers[field];
  }
  return kept as MessageHeaders;
}
