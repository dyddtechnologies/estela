import { ChannelNotFoundError } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import {
  describeCare,
  expandCareRef,
  CARE_PARTS,
  type CarePartName,
  type CarePlan,
} from '../resilience/resilience.plan';
import { CareConfigError, type FlowParameterFinding } from '../resilience/resilience.errors';
import { planBLeaveRunner } from '../resilience/fallback';
import { PlanBMode, type Care, type CareRef } from '../resilience/resilience.types';
import type { CareEngine } from '../resilience/runtime';
import { FlowDefinitionError } from './flow-definition-error';
import type { FlowOptions, FlowStep, FlowTarget, StepCarePort } from './flow-step';
import {
  flowAdapter,
  LEGACY_JUMP_WAIT_MS,
  StepCare,
  TargetCare,
  type FlowEdgeKind,
} from './flow-resilience';
import { stepIdOf, type BuiltFlow, type FlowDefinition } from './integration-flow';
import { withoutReplyRouting } from './steps/reply-routing';
import type { IntegrationMessage } from '../message';

type Family = keyof NonNullable<FlowOptions['care']>;
type Level = 'L4' | 'L3' | 'L2' | 'L1';

/** One reference of a subject, with the level it was written at and its option path. */
interface LayerRef {
  ref: CareRef | undefined;
  level: Level;
  path: string;
}

/** Everything needed to resolve one subject (a `handle` step or one target). */
interface SubjectSpec {
  /** Human subject for findings: `flow 'f' step 'id'` (plus ` target 'ch'`). */
  label: string;
  /** Event and valve binding: `flow:<flow>#<id>` or `flow:<flow>#<id>:<channel>`. */
  binding: string;
  edge: FlowEdgeKind;
  kind: FlowStep['kind'];
  channel?: string;
  layers: readonly LayerRef[];
  forget: boolean;
  /** Legacy jump `timeoutMs` of the target (RS-62 alias). */
  timeoutMs?: number;
}

interface SubjectResult {
  care?: TargetCare;
  plan?: CarePlan;
}

/** Graph annotation of a subject (RS-66): names only, never values. */
export interface CareAnnotation {
  care: string;
  repeatableBy: 'key' | 'declared' | 'none';
}

export interface ResolvedFlow {
  readonly name: string;
  readonly built: BuiltFlow;
  /** Step care by index; `undefined` where a step runs the 0.9.0 path. */
  readonly stepCare: readonly (StepCarePort | undefined)[];
  /** `describe()` of each step with the RS-66 annotations (byte-identical when unconfigured). */
  readonly described: readonly Record<string, unknown>[];
}

/** A send or jump target whose effective care tries again (input of TRIES_STACKED, RS-56). */
export interface TryingTarget {
  readonly subject: string;
  readonly channel: string;
}

export interface FlowResolution {
  readonly flows: readonly ResolvedFlow[];
  /** Every finding, warnings included; errors make `resolve` throw instead. */
  readonly findings: readonly FlowParameterFinding[];
  readonly tryingTargets: readonly TryingTarget[];
  /** Summary of each channel declared with `care` (graph, RS-66). */
  readonly channelCare: ReadonlyMap<string, string>;
}

const FAMILY_OF: Partial<Record<FlowStep['kind'], Family>> = {
  handle: 'handle',
  jump: 'jump',
  to: 'send',
  publish: 'send',
  route: 'send',
  fanout: 'send',
};

const EDGE_OF: Record<Family, FlowEdgeKind> = {
  handle: 'flow-handle',
  jump: 'flow-jump',
  send: 'flow-send',
};

/** RS-60, RS-66: what makes an extra try of this plan safe. */
export function repeatableByOf(plan: CarePlan): CareAnnotation['repeatableBy'] {
  if (plan.tries === undefined || plan.tries.max <= 1) return 'none';
  return plan.tries.idempotent ? 'declared' : 'key';
}

function annotationOf(plan: CarePlan): CareAnnotation {
  return { care: describeCare(plan) ?? 'configured', repeatableBy: repeatableByOf(plan) };
}

/** A `to` step takes a plan B channel with no value; `PlanBMode.Ask` has no answer to take there. */
function isChannelPlanB(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const planB = value as { channel?: unknown; value?: unknown; mode?: unknown };
  return planB.channel !== undefined && planB.value === undefined && planB.mode !== PlanBMode.Ask;
}

/** RS-59 (section 5.5 rows): may this part value sit on this subject's edge? */
function allowedOn(spec: SubjectSpec, name: CarePartName, value: unknown): boolean {
  if (name !== 'planB') return true;
  if (spec.edge === 'flow-handle') return true;
  if (spec.edge === 'flow-jump') return !spec.forget;
  return spec.kind === 'to' && isChannelPlanB(value);
}

function careFinding(
  severity: 'error' | 'warning',
  code: string,
  subject: string,
  path: string,
  rule: string,
): FlowParameterFinding {
  return {
    concern: 'care',
    code,
    severity,
    subject,
    path,
    message: `${subject}: ${path} ${rule}`,
  };
}

/** A definition error raised with the event binding, renamed to the human subject. */
function relabel(error: CareConfigError, label: string, binding: string): FlowParameterFinding[] {
  return error.findings.map((finding) => ({
    ...finding,
    subject: finding.subject === binding ? label : finding.subject,
    message: finding.message.startsWith(`${binding}:`)
      ? `${label}${finding.message.slice(binding.length)}`
      : finding.message,
  }));
}

/** One error for every finding, of the class of their concern (RS-67). */
export function definitionErrorOf(findings: readonly FlowParameterFinding[]): Error | undefined {
  const errors = findings.filter((finding) => finding.severity === 'error');
  const first = errors[0];
  if (first === undefined) return undefined;
  if (errors.some((finding) => finding.concern !== 'care')) {
    return new FlowDefinitionError(findings);
  }
  const prefix = `${first.subject}: ${first.path} `;
  const rule = first.message.startsWith(prefix)
    ? first.message.slice(prefix.length)
    : first.message;
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more finding(s))` : '';
  const path = first.path.startsWith('care.') ? first.path.slice('care.'.length) : first.path;
  return new CareConfigError(first.subject, path, `${rule}${more}`, first.code, findings);
}

/**
 * Boot resolver of the flow parameter model (RS-67), care concern only (minimal
 * scaffolding pending SPI-433, SD-67). It builds every flow once, resolves every reference of
 * every subject over L4 > L3 > L2 > L1 (RS-51), collects every finding and then throws one error
 * or logs each warning once.
 */
export class FlowParameterResolver {
  private readonly findings: FlowParameterFinding[] = [];
  private readonly trying: TryingTarget[] = [];
  private readonly logged = new Set<string>();

  constructor(
    private readonly runtime: CareEngine,
    private readonly registry: ChannelRegistry,
  ) {}

  resolve(definitions: readonly FlowDefinition[]): FlowResolution {
    const channelCare = this.resolveChannels();
    const flows: ResolvedFlow[] = [];
    for (const definition of definitions) {
      const built = this.build(definition);
      if (built !== undefined) flows.push(this.resolveFlow(definition.name, built));
    }
    const error = definitionErrorOf(this.findings);
    if (error !== undefined) throw error;
    this.logWarnings(this.findings);
    return {
      flows,
      findings: [...this.findings],
      tryingTargets: [...this.trying],
      channelCare,
    };
  }

  private build(definition: FlowDefinition): BuiltFlow | undefined {
    try {
      return definition.build().build();
    } catch (error) {
      if (!(error instanceof FlowDefinitionError)) throw error;
      const prefix = `flow '${definition.name}' `;
      for (const finding of error.findings) {
        this.findings.push({
          ...finding,
          subject: `${prefix}${finding.subject}`,
          message: `${prefix}${finding.message}`,
        });
      }
      return undefined;
    }
  }

  /** Validates every `ChannelSpec.care` once and summarizes it for the graph. */
  private resolveChannels(): Map<string, string> {
    const summaries = new Map<string, string>();
    for (const channel of this.runtime.channelsWithCare) {
      const binding = `channel:${channel}`;
      const label = `channel '${channel}'`;
      try {
        const plan = this.runtime.plan(
          binding,
          [this.runtime.channelCareRef(channel)],
          'flow-send',
        );
        const summary = describeCare(plan);
        if (summary !== undefined) summaries.set(channel, summary);
      } catch (error) {
        if (!(error instanceof CareConfigError)) throw error;
        this.findings.push(...relabel(error, label, binding));
      }
    }
    return summaries;
  }

  private resolveFlow(name: string, built: BuiltFlow): ResolvedFlow {
    const stepCare: (StepCarePort | undefined)[] = [];
    const described: Record<string, unknown>[] = [];
    built.steps.forEach((step, index) => {
      const { care, annotate } = this.resolveStep(name, built, step, index);
      stepCare.push(care);
      described.push(annotate(step.describe()));
    });
    return { name, built, stepCare, described };
  }

  private resolveStep(
    flow: string,
    built: BuiltFlow,
    step: FlowStep,
    index: number,
  ): { care?: StepCare; annotate: (base: Record<string, unknown>) => Record<string, unknown> } {
    const id = stepIdOf(step, index);
    const family = FAMILY_OF[step.kind];
    const explicitId = step.params?.id !== undefined;
    if (family === undefined) return { annotate: (base) => withId(base, explicitId, id) };
    const context = { flow, id, family, step, flowRef: built.options?.care?.[family] };
    if (step.kind === 'handle') return this.resolveHandle(context, explicitId);
    if (step.kind === 'route') return this.resolveRoute(context, explicitId);
    return this.resolveTargets(context, explicitId);
  }

  private stepLayers(context: StepContext): LayerRef[] {
    return [
      { ref: context.step.params?.care, level: 'L4', path: 'care' },
      { ref: context.flowRef, level: 'L3', path: `options.care.${context.family}` },
    ];
  }

  private defaultLayer(edge: FlowEdgeKind): LayerRef {
    return {
      ref: this.runtime.options.defaults?.[edge],
      level: 'L1',
      path: `care.defaults.${edge}`,
    };
  }

  private resolveHandle(
    context: StepContext,
    explicitId: boolean,
  ): { care?: StepCare; annotate: (base: Record<string, unknown>) => Record<string, unknown> } {
    const edge = EDGE_OF[context.family];
    const result = this.resolveSubject({
      label: `flow '${context.flow}' step '${context.id}'`,
      binding: `flow:${context.flow}#${context.id}`,
      edge,
      kind: 'handle',
      layers: [...this.stepLayers(context), this.defaultLayer(edge)],
      forget: false,
    });
    const annotate = (base: Record<string, unknown>): Record<string, unknown> =>
      result.plan === undefined
        ? withId(base, explicitId, context.id)
        : { ...withId(base, true, context.id), ...annotationOf(result.plan) };
    if (result.care === undefined) return { annotate };
    return { care: new StepCare(new Map(), result.care), annotate };
  }

  /** `route` targets are known only at run time; the step references are validated here. */
  private resolveRoute(
    context: StepContext,
    explicitId: boolean,
  ): { care?: StepCare; annotate: (base: Record<string, unknown>) => Record<string, unknown> } {
    const edge = EDGE_OF[context.family];
    const label = `flow '${context.flow}' step '${context.id}'`;
    const binding = `flow:${context.flow}#${context.id}`;
    const subject = (channel?: string): SubjectSpec => ({
      label: channel === undefined ? label : `${label} target '${channel}'`,
      binding: channel === undefined ? binding : `${binding}:${channel}`,
      edge,
      kind: 'route',
      ...(channel === undefined ? {} : { channel }),
      layers: [
        ...this.stepLayers(context),
        ...(channel === undefined ? [] : [this.channelLayer(channel)]),
        this.defaultLayer(edge),
      ],
      forget: false,
    });
    const probe = this.resolveSubject(subject(), false);
    const annotate = (base: Record<string, unknown>): Record<string, unknown> =>
      probe.plan === undefined
        ? withId(base, explicitId, context.id)
        : { ...withId(base, true, context.id), ...annotationOf(probe.plan) };
    const lazy = (channel: string): TargetCare | undefined => {
      if (this.registry.tryGet(channel) === undefined) throw new ChannelNotFoundError(channel);
      return this.resolveLate(subject(channel));
    };
    return { care: new StepCare(new Map(), undefined, lazy), annotate };
  }

  /** Run-time resolution of a `route` target; boot already validated the references. */
  private resolveLate(spec: SubjectSpec): TargetCare | undefined {
    const before = this.findings.length;
    const result = this.resolveSubject(spec);
    const late = this.findings.splice(before);
    const error = definitionErrorOf(late);
    if (error !== undefined) throw error;
    this.logWarnings(late);
    return result.care;
  }

  private channelLayer(channel: string): LayerRef {
    return {
      ref: this.runtime.channelCareRef(channel),
      level: 'L2',
      path: `channels.${channel}.care`,
    };
  }

  private resolveTargets(
    context: StepContext,
    explicitId: boolean,
  ): { care?: StepCare; annotate: (base: Record<string, unknown>) => Record<string, unknown> } {
    const edge = EDGE_OF[context.family];
    const targets = context.step.params?.targets ?? [];
    const plans = new Map<string, CarePlan>();
    const cares = new Map<string, TargetCare>();
    for (const target of targets) {
      const result = this.resolveSubject(this.targetSpec(context, edge, target));
      if (result.plan !== undefined) plans.set(target.channel, result.plan);
      if (result.care !== undefined) cares.set(target.channel, result.care);
    }
    const annotate = (base: Record<string, unknown>): Record<string, unknown> =>
      annotateTargets(base, plans, explicitId, context.id);
    if (cares.size === 0) return { annotate };
    return { care: new StepCare(cares), annotate };
  }

  private targetSpec(context: StepContext, edge: FlowEdgeKind, target: FlowTarget): SubjectSpec {
    const spec: SubjectSpec = {
      label: `flow '${context.flow}' step '${context.id}' target '${target.channel}'`,
      binding: `flow:${context.flow}#${context.id}:${target.channel}`,
      edge,
      kind: context.step.kind,
      channel: target.channel,
      layers: [
        { ref: target.care, level: 'L4', path: 'target.care' },
        ...this.stepLayers(context),
        this.channelLayer(target.channel),
        this.defaultLayer(edge),
      ],
      forget: target.wait === false,
    };
    if (target.timeoutMs !== undefined) spec.timeoutMs = target.timeoutMs;
    return spec;
  }

  /**
   * Resolves one subject: expands every reference (the first `false` cuts the lower levels),
   * applies the edge restrictions (RS-59), resolves and validates the plan (section 5.6) and
   * creates its executor. An empty plan means the 0.9.0 code path (RS-70).
   */
  private resolveSubject(spec: SubjectSpec, withExecutor = true): SubjectResult {
    const before = this.errorCount();
    const layers = this.expand(spec);
    this.checkLegacyTimeout(spec, layers);
    if (this.errorCount() > before) return {};
    const plan = this.plan(
      spec,
      layers.map((layer) => layer.care),
    );
    if (plan === undefined || plan.empty) return {};
    this.checkPlan(spec, plan);
    if (this.errorCount() > before) return {};
    if (!withExecutor) return { plan };
    if (
      spec.channel !== undefined &&
      spec.edge !== 'flow-handle' &&
      repeatableByOf(plan) !== 'none'
    ) {
      this.trying.push({ subject: spec.label, channel: spec.channel });
    }
    return { plan, care: this.careOf(spec, plan) };
  }

  private errorCount(): number {
    return this.findings.filter((finding) => finding.severity === 'error').length;
  }

  private expand(spec: SubjectSpec): { care: Care; level: Level }[] {
    const out: { care: Care; level: Level }[] = [];
    for (const layer of spec.layers) {
      let expanded: Care | false | undefined;
      try {
        expanded = expandCareRef(spec.label, layer.ref, this.runtime.options.profiles);
      } catch (error) {
        if (!(error instanceof CareConfigError)) throw error;
        this.findings.push(...error.findings);
        continue;
      }
      if (expanded === false) break;
      if (expanded !== undefined)
        out.push({ care: this.restrict(spec, expanded, layer), level: layer.level });
    }
    return out;
  }

  /** RS-59: a refused part fails at L4 and is dropped, with one warning, from L1..L3. */
  private restrict(spec: SubjectSpec, care: Care, layer: LayerRef): Care {
    let out = care;
    for (const name of CARE_PARTS) {
      const value = care[name];
      if (value === undefined || value === false || allowedOn(spec, name, value)) continue;
      if (layer.level === 'L4') {
        this.findings.push(
          careFinding(
            'error',
            'CARE_PART_NOT_ALLOWED',
            spec.label,
            `care.${name}`,
            `is not allowed on a ${spec.edge} ${spec.forget ? 'forget ' : ''}edge`,
          ),
        );
        continue;
      }
      this.findings.push(
        careFinding(
          'warning',
          'CARE_PART_DROPPED',
          spec.label,
          `care.${name}`,
          `inherited from ${layer.path} is not allowed on a ${spec.edge} edge and was dropped`,
        ),
      );
      out = { ...out, [name]: undefined };
    }
    return out;
  }

  /** RS-62: a target `timeoutMs` and an L4 `patience.eachTryMs` are one option set twice. */
  private checkLegacyTimeout(
    spec: SubjectSpec,
    layers: readonly { care: Care; level: Level }[],
  ): void {
    if (spec.timeoutMs === undefined) return;
    const clash = layers.some(
      (layer) =>
        layer.level === 'L4' &&
        typeof layer.care.patience === 'object' &&
        layer.care.patience.eachTryMs !== undefined,
    );
    if (!clash) return;
    this.findings.push(
      careFinding(
        'error',
        'LEGACY_AND_NEW_SAME_LAYER',
        spec.label,
        'care.patience.eachTryMs',
        'is set together with the legacy timeoutMs of the same target',
      ),
    );
  }

  private plan(spec: SubjectSpec, layers: readonly Care[]): CarePlan | undefined {
    try {
      return this.runtime.plan(spec.binding, layers, spec.edge);
    } catch (error) {
      if (!(error instanceof CareConfigError)) throw error;
      this.findings.push(...relabel(error, spec.label, spec.binding));
      return undefined;
    }
  }

  /** PLAN_B_CHANNEL_MISSING and the boot notes of section 5.6 (RS-60, RS-64). */
  private checkPlan(spec: SubjectSpec, plan: CarePlan): void {
    const channel = plan.planB?.channel;
    if (channel !== undefined && this.registry.tryGet(channel) === undefined) {
      this.findings.push(
        careFinding(
          'error',
          'PLAN_B_CHANNEL_MISSING',
          spec.label,
          'care.planB.channel',
          `names a channel that is not registered: '${channel}'`,
        ),
      );
    }
    if (plan.tries?.idempotent === true && plan.tries.max > 1) {
      this.findings.push(
        careFinding(
          'warning',
          'TRIES_DECLARED_IDEMPOTENT',
          spec.label,
          'care.tries.idempotent',
          'is true: extra tries run without an idempotency key',
        ),
      );
    }
    if (plan.planB?.cacheable === true) {
      this.findings.push(
        careFinding(
          'warning',
          'PLAN_B_CACHEABLE',
          spec.label,
          'care.planB.cacheable',
          'is true: a plan B answer does not mark the run',
        ),
      );
    }
  }

  private careOf(spec: SubjectSpec, plan: CarePlan): TargetCare {
    const registry = this.registry;
    const send = spec.edge === 'flow-send';
    const planBChannel = send
      ? // RS-59: `to` re-sends the same hop (reply inherited) as a plain send.
        async (channel: string, ctx: { data?: unknown }): Promise<unknown> => {
          await registry.sendMessage(channel, hopOf(ctx));
          return undefined;
        }
      : this.runtime.channelPlanB();
    const planBLeave = send
      ? // D39: `PlanBMode.Leave` on `to` sends the same hop without its reply routing.
        async (channel: string, ctx: { data?: unknown }): Promise<unknown> => {
          await registry.sendMessage(channel, withoutReplyRouting(hopOf(ctx)));
          return undefined;
        }
      : planBLeaveRunner((channel, payload, headers) => registry.send(channel, payload, headers));
    const executor = this.runtime.executor(
      plan,
      flowAdapter(spec.edge, spec.binding, spec.channel),
      {
        planBChannel,
        planBLeave,
        ...(spec.forget ? { shutdown: this.runtime.shutdownSignal } : {}),
      },
    );
    const eachTryMs = spec.edge === 'flow-jump' ? jumpWait(plan, spec.timeoutMs) : undefined;
    return new TargetCare(
      spec.binding,
      spec.edge,
      spec.channel,
      executor,
      eachTryMs === undefined ? {} : { eachTryMs },
    );
  }

  private logWarnings(findings: readonly FlowParameterFinding[]): void {
    for (const finding of findings) {
      if (finding.severity !== 'warning' || this.logged.has(finding.message)) continue;
      this.logged.add(finding.message);
      this.runtime.observer.logger.warn(`${finding.code}: ${finding.message}`);
    }
  }
}

/** The hop a `to` step sends, carried as the care call data (`sendHop`). */
function hopOf(ctx: { data?: unknown }): IntegrationMessage {
  return (ctx.data as { hop: IntegrationMessage }).hop;
}

interface StepContext {
  flow: string;
  id: string;
  family: Family;
  step: FlowStep;
  flowRef: CareRef | undefined;
}

/**
 * RS-62: the wait of one jump try. The 0.9.0 `timeoutMs` is the L4 spelling of `eachTryMs`;
 * without any level setting it the 0.9.0 wait applies; a wait is never unbounded.
 */
function jumpWait(plan: CarePlan, timeoutMs: number | undefined): number | undefined {
  if (timeoutMs !== undefined) return timeoutMs;
  if (!plan.patienceExplicit) return LEGACY_JUMP_WAIT_MS;
  if (plan.eachTryMs === 0 && plan.totalMs === undefined) return LEGACY_JUMP_WAIT_MS;
  return undefined;
}

/** RS-66: `id` only on a step with an explicit id or an effective care. */
function withId(base: Record<string, unknown>, show: boolean, id: string): Record<string, unknown> {
  if (!show) return base;
  return { kind: base.kind, id, ...base };
}

function annotateTargets(
  base: Record<string, unknown>,
  plans: ReadonlyMap<string, CarePlan>,
  explicitId: boolean,
  id: string,
): Record<string, unknown> {
  if (plans.size === 0) return withId(base, explicitId, id);
  const out = withId(base, true, id);
  if (Array.isArray(base.dests)) {
    out.dests = (base.dests as Record<string, unknown>[]).map((dest) => {
      const plan = plans.get(String(dest.channel));
      return plan === undefined ? dest : { ...dest, ...annotationOf(plan) };
    });
    return out;
  }
  const plan = plans.get(String(base.channel));
  return plan === undefined ? out : { ...out, ...annotationOf(plan) };
}
