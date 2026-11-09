import { ChannelNotFoundError } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import {
  describePolicy,
  expandPolicyRef,
  PRIMITIVES,
  type PrimitiveName,
  type ResiliencePlan,
} from '../resilience/resilience.plan';
import {
  ResilienceDefinitionError,
  type FlowParameterFinding,
} from '../resilience/resilience.errors';
import type { ResiliencePolicy, ResilienceRef } from '../resilience/resilience.types';
import type { ResilienceRuntime } from '../resilience/runtime';
import { FlowDefinitionError } from './flow-definition-error';
import type { FlowOptions, FlowStep, FlowTarget, StepPolicyPort } from './flow-step';
import {
  flowAdapter,
  LEGACY_JUMP_WAIT_MS,
  StepPolicy,
  TargetPolicy,
  type FlowEdgeKind,
} from './flow-resilience';
import { stepIdOf, type BuiltFlow, type FlowDefinition } from './integration-flow';

type Family = keyof NonNullable<FlowOptions['resilience']>;
type Level = 'L4' | 'L3' | 'L2' | 'L1';

/** One reference of a subject, with the level it was written at and its option path. */
interface LayerRef {
  ref: ResilienceRef | undefined;
  level: Level;
  path: string;
}

/** Everything needed to resolve one subject (a `handle` step or one target). */
interface SubjectSpec {
  /** Human subject for findings: `flow 'f' step 'id'` (plus ` target 'ch'`). */
  label: string;
  /** Event and breaker binding: `flow:<flow>#<id>` or `flow:<flow>#<id>:<channel>`. */
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
  policy?: TargetPolicy;
  plan?: ResiliencePlan;
}

/** Graph annotation of a subject (RS-66): names only, never values. */
export interface PolicyAnnotation {
  policy: string;
  retryGate: 'key' | 'declared' | 'none';
}

export interface ResolvedFlow {
  readonly name: string;
  readonly built: BuiltFlow;
  /** Step policies by index; `undefined` where a step runs the 0.9.0 path. */
  readonly policies: readonly (StepPolicyPort | undefined)[];
  /** `describe()` of each step with the RS-66 annotations (byte-identical when unconfigured). */
  readonly described: readonly Record<string, unknown>[];
}

/** A send or jump target whose effective policy retries (input of RETRY_STACKED, RS-56). */
export interface RetryingTarget {
  readonly subject: string;
  readonly channel: string;
}

export interface FlowResolution {
  readonly flows: readonly ResolvedFlow[];
  /** Every finding, warnings included; errors make `resolve` throw instead. */
  readonly findings: readonly FlowParameterFinding[];
  readonly retryingTargets: readonly RetryingTarget[];
  /** Summary of each channel declared with `resilience` (graph, RS-66). */
  readonly channelPolicies: ReadonlyMap<string, string>;
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

/** RS-60, RS-66: how a retry of this plan is gated. */
export function retryGateOf(plan: ResiliencePlan): PolicyAnnotation['retryGate'] {
  if (plan.retry === undefined || plan.retry.maxAttempts <= 1) return 'none';
  return plan.retry.idempotent ? 'declared' : 'key';
}

function annotationOf(plan: ResiliencePlan): PolicyAnnotation {
  return { policy: describePolicy(plan) ?? 'configured', retryGate: retryGateOf(plan) };
}

function isChannelFallback(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const fallback = value as { channel?: unknown; value?: unknown };
  return fallback.channel !== undefined && fallback.value === undefined;
}

/** RS-59 (section 5.5 rows): may this primitive value sit on this subject's edge? */
function allowedOn(spec: SubjectSpec, name: PrimitiveName, value: unknown): boolean {
  if (name !== 'fallback') return true;
  if (spec.edge === 'flow-handle') return true;
  if (spec.edge === 'flow-jump') return !spec.forget;
  return spec.kind === 'to' && isChannelFallback(value);
}

function resilienceFinding(
  severity: 'error' | 'warning',
  code: string,
  subject: string,
  path: string,
  rule: string,
): FlowParameterFinding {
  return {
    concern: 'resilience',
    code,
    severity,
    subject,
    path,
    message: `${subject}: ${path} ${rule}`,
  };
}

/** A definition error raised with the event binding, renamed to the human subject. */
function relabel(
  error: ResilienceDefinitionError,
  label: string,
  binding: string,
): FlowParameterFinding[] {
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
  if (errors.some((finding) => finding.concern !== 'resilience')) {
    return new FlowDefinitionError(findings);
  }
  const prefix = `${first.subject}: ${first.path} `;
  const rule = first.message.startsWith(prefix)
    ? first.message.slice(prefix.length)
    : first.message;
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more finding(s))` : '';
  const path = first.path.startsWith('resilience.')
    ? first.path.slice('resilience.'.length)
    : first.path;
  return new ResilienceDefinitionError(first.subject, path, `${rule}${more}`, first.code, findings);
}

/**
 * Boot resolver of the flow parameter model (RS-67), resilience concern only (minimal
 * scaffolding pending SPI-433, SD-67). It builds every flow once, resolves every reference of
 * every subject over L4 > L3 > L2 > L1 (RS-51), collects every finding and then throws one error
 * or logs each warning once.
 */
export class FlowParameterResolver {
  private readonly findings: FlowParameterFinding[] = [];
  private readonly retrying: RetryingTarget[] = [];
  private readonly logged = new Set<string>();

  constructor(
    private readonly runtime: ResilienceRuntime,
    private readonly registry: ChannelRegistry,
  ) {}

  resolve(definitions: readonly FlowDefinition[]): FlowResolution {
    const channelPolicies = this.resolveChannels();
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
      retryingTargets: [...this.retrying],
      channelPolicies,
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

  /** Validates every `ChannelSpec.resilience` once and summarizes it for the graph. */
  private resolveChannels(): Map<string, string> {
    const summaries = new Map<string, string>();
    for (const channel of this.runtime.channelsWithPolicy) {
      const binding = `channel:${channel}`;
      const label = `channel '${channel}'`;
      try {
        const plan = this.runtime.plan(binding, [this.runtime.channelPolicy(channel)], 'flow-send');
        const summary = describePolicy(plan);
        if (summary !== undefined) summaries.set(channel, summary);
      } catch (error) {
        if (!(error instanceof ResilienceDefinitionError)) throw error;
        this.findings.push(...relabel(error, label, binding));
      }
    }
    return summaries;
  }

  private resolveFlow(name: string, built: BuiltFlow): ResolvedFlow {
    const policies: (StepPolicyPort | undefined)[] = [];
    const described: Record<string, unknown>[] = [];
    built.steps.forEach((step, index) => {
      const { policy, annotate } = this.resolveStep(name, built, step, index);
      policies.push(policy);
      described.push(annotate(step.describe()));
    });
    return { name, built, policies, described };
  }

  private resolveStep(
    flow: string,
    built: BuiltFlow,
    step: FlowStep,
    index: number,
  ): { policy?: StepPolicy; annotate: (base: Record<string, unknown>) => Record<string, unknown> } {
    const id = stepIdOf(step, index);
    const family = FAMILY_OF[step.kind];
    const explicitId = step.params?.id !== undefined;
    if (family === undefined) return { annotate: (base) => withId(base, explicitId, id) };
    const context = { flow, id, family, step, flowRef: built.options?.resilience?.[family] };
    if (step.kind === 'handle') return this.resolveHandle(context, explicitId);
    if (step.kind === 'route') return this.resolveRoute(context, explicitId);
    return this.resolveTargets(context, explicitId);
  }

  private stepLayers(context: StepContext): LayerRef[] {
    return [
      { ref: context.step.params?.resilience, level: 'L4', path: 'resilience' },
      { ref: context.flowRef, level: 'L3', path: `options.resilience.${context.family}` },
    ];
  }

  private defaultLayer(edge: FlowEdgeKind): LayerRef {
    return {
      ref: this.runtime.options.defaults?.[edge],
      level: 'L1',
      path: `resilience.defaults.${edge}`,
    };
  }

  private resolveHandle(
    context: StepContext,
    explicitId: boolean,
  ): { policy?: StepPolicy; annotate: (base: Record<string, unknown>) => Record<string, unknown> } {
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
    if (result.policy === undefined) return { annotate };
    return { policy: new StepPolicy(new Map(), result.policy), annotate };
  }

  /** `route` targets are known only at run time; the step references are validated here. */
  private resolveRoute(
    context: StepContext,
    explicitId: boolean,
  ): { policy?: StepPolicy; annotate: (base: Record<string, unknown>) => Record<string, unknown> } {
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
    const lazy = (channel: string): TargetPolicy | undefined => {
      if (this.registry.tryGet(channel) === undefined) throw new ChannelNotFoundError(channel);
      return this.resolveLate(subject(channel));
    };
    return { policy: new StepPolicy(new Map(), undefined, lazy), annotate };
  }

  /** Run-time resolution of a `route` target; boot already validated the references. */
  private resolveLate(spec: SubjectSpec): TargetPolicy | undefined {
    const before = this.findings.length;
    const result = this.resolveSubject(spec);
    const late = this.findings.splice(before);
    const error = definitionErrorOf(late);
    if (error !== undefined) throw error;
    this.logWarnings(late);
    return result.policy;
  }

  private channelLayer(channel: string): LayerRef {
    return {
      ref: this.runtime.channelPolicy(channel),
      level: 'L2',
      path: `channels.${channel}.resilience`,
    };
  }

  private resolveTargets(
    context: StepContext,
    explicitId: boolean,
  ): { policy?: StepPolicy; annotate: (base: Record<string, unknown>) => Record<string, unknown> } {
    const edge = EDGE_OF[context.family];
    const targets = context.step.params?.targets ?? [];
    const plans = new Map<string, ResiliencePlan>();
    const policies = new Map<string, TargetPolicy>();
    for (const target of targets) {
      const result = this.resolveSubject(this.targetSpec(context, edge, target));
      if (result.plan !== undefined) plans.set(target.channel, result.plan);
      if (result.policy !== undefined) policies.set(target.channel, result.policy);
    }
    const annotate = (base: Record<string, unknown>): Record<string, unknown> =>
      annotateTargets(base, plans, explicitId, context.id);
    if (policies.size === 0) return { annotate };
    return { policy: new StepPolicy(policies), annotate };
  }

  private targetSpec(context: StepContext, edge: FlowEdgeKind, target: FlowTarget): SubjectSpec {
    const spec: SubjectSpec = {
      label: `flow '${context.flow}' step '${context.id}' target '${target.channel}'`,
      binding: `flow:${context.flow}#${context.id}:${target.channel}`,
      edge,
      kind: context.step.kind,
      channel: target.channel,
      layers: [
        { ref: target.resilience, level: 'L4', path: 'target.resilience' },
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
      layers.map((layer) => layer.policy),
    );
    if (plan === undefined || plan.empty) return {};
    this.checkPlan(spec, plan);
    if (this.errorCount() > before) return {};
    if (!withExecutor) return { plan };
    if (spec.channel !== undefined && spec.edge !== 'flow-handle' && retryGateOf(plan) !== 'none') {
      this.retrying.push({ subject: spec.label, channel: spec.channel });
    }
    return { plan, policy: this.policyOf(spec, plan) };
  }

  private errorCount(): number {
    return this.findings.filter((finding) => finding.severity === 'error').length;
  }

  private expand(spec: SubjectSpec): { policy: ResiliencePolicy; level: Level }[] {
    const out: { policy: ResiliencePolicy; level: Level }[] = [];
    for (const layer of spec.layers) {
      let expanded: ResiliencePolicy | false | undefined;
      try {
        expanded = expandPolicyRef(spec.label, layer.ref, this.runtime.options.policies);
      } catch (error) {
        if (!(error instanceof ResilienceDefinitionError)) throw error;
        this.findings.push(...error.findings);
        continue;
      }
      if (expanded === false) break;
      if (expanded !== undefined)
        out.push({ policy: this.restrict(spec, expanded, layer), level: layer.level });
    }
    return out;
  }

  /** RS-59: a refused primitive fails at L4 and is dropped, with one warning, from L1..L3. */
  private restrict(spec: SubjectSpec, policy: ResiliencePolicy, layer: LayerRef): ResiliencePolicy {
    let out = policy;
    for (const name of PRIMITIVES) {
      const value = policy[name];
      if (value === undefined || value === false || allowedOn(spec, name, value)) continue;
      if (layer.level === 'L4') {
        this.findings.push(
          resilienceFinding(
            'error',
            'PRIMITIVE_NOT_ALLOWED',
            spec.label,
            `resilience.${name}`,
            `is not allowed on a ${spec.edge} ${spec.forget ? 'forget ' : ''}edge`,
          ),
        );
        continue;
      }
      this.findings.push(
        resilienceFinding(
          'warning',
          'PRIMITIVE_DROPPED',
          spec.label,
          `resilience.${name}`,
          `inherited from ${layer.path} is not allowed on a ${spec.edge} edge and was dropped`,
        ),
      );
      out = { ...out, [name]: undefined };
    }
    return out;
  }

  /** RS-62: a target `timeoutMs` and an L4 `timeout.perAttemptMs` are one option set twice. */
  private checkLegacyTimeout(
    spec: SubjectSpec,
    layers: readonly { policy: ResiliencePolicy; level: Level }[],
  ): void {
    if (spec.timeoutMs === undefined) return;
    const clash = layers.some(
      (layer) =>
        layer.level === 'L4' &&
        typeof layer.policy.timeout === 'object' &&
        layer.policy.timeout.perAttemptMs !== undefined,
    );
    if (!clash) return;
    this.findings.push(
      resilienceFinding(
        'error',
        'LEGACY_AND_NEW_SAME_LAYER',
        spec.label,
        'resilience.timeout.perAttemptMs',
        'is set together with the legacy timeoutMs of the same target',
      ),
    );
  }

  private plan(spec: SubjectSpec, layers: readonly ResiliencePolicy[]): ResiliencePlan | undefined {
    try {
      return this.runtime.plan(spec.binding, layers, spec.edge);
    } catch (error) {
      if (!(error instanceof ResilienceDefinitionError)) throw error;
      this.findings.push(...relabel(error, spec.label, spec.binding));
      return undefined;
    }
  }

  /** FALLBACK_CHANNEL_MISSING and the boot notes of section 5.6 (RS-60, RS-64). */
  private checkPlan(spec: SubjectSpec, plan: ResiliencePlan): void {
    const channel = plan.fallback?.channel;
    if (channel !== undefined && this.registry.tryGet(channel) === undefined) {
      this.findings.push(
        resilienceFinding(
          'error',
          'FALLBACK_CHANNEL_MISSING',
          spec.label,
          'resilience.fallback.channel',
          `names a channel that is not registered: '${channel}'`,
        ),
      );
    }
    if (plan.retry?.idempotent === true && plan.retry.maxAttempts > 1) {
      this.findings.push(
        resilienceFinding(
          'warning',
          'RETRY_DECLARED_IDEMPOTENT',
          spec.label,
          'resilience.retry.idempotent',
          'is true: retries run without an idempotency key',
        ),
      );
    }
    if (plan.fallback?.cacheable === true) {
      this.findings.push(
        resilienceFinding(
          'warning',
          'FALLBACK_CACHEABLE',
          spec.label,
          'resilience.fallback.cacheable',
          'is true: a fallback result does not mark the run degraded',
        ),
      );
    }
  }

  private policyOf(spec: SubjectSpec, plan: ResiliencePlan): TargetPolicy {
    const registry = this.registry;
    const fallbackChannel =
      spec.edge === 'flow-send'
        ? // RS-59: `to` re-sends the same hop (reply inherited) as a plain send.
          async (channel: string, ctx: { data?: unknown }): Promise<unknown> => {
            const hop = (ctx.data as { hop: Parameters<ChannelRegistry['sendMessage']>[1] }).hop;
            await registry.sendMessage(channel, hop);
            return undefined;
          }
        : this.runtime.channelFallback();
    const executor = this.runtime.executor(
      plan,
      flowAdapter(spec.edge, spec.binding, spec.channel),
      {
        fallbackChannel,
        ...(spec.forget ? { shutdown: this.runtime.shutdownSignal } : {}),
      },
    );
    const perAttemptMs = spec.edge === 'flow-jump' ? jumpWait(plan, spec.timeoutMs) : undefined;
    return new TargetPolicy(
      spec.binding,
      spec.edge,
      spec.channel,
      executor,
      perAttemptMs === undefined ? {} : { perAttemptMs },
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

interface StepContext {
  flow: string;
  id: string;
  family: Family;
  step: FlowStep;
  flowRef: ResilienceRef | undefined;
}

/**
 * RS-62: the per-attempt wait of a jump plan. The legacy `timeoutMs` is the L4 alias of
 * `perAttemptMs`; without any level setting it the 0.9.0 wait applies; a wait is never unbounded.
 */
function jumpWait(plan: ResiliencePlan, timeoutMs: number | undefined): number | undefined {
  if (timeoutMs !== undefined) return timeoutMs;
  if (!plan.timeoutExplicit) return LEGACY_JUMP_WAIT_MS;
  if (plan.perAttemptMs === 0 && plan.deadlineMs === undefined) return LEGACY_JUMP_WAIT_MS;
  return undefined;
}

/** RS-66: `id` only on a step with an explicit id or an effective policy. */
function withId(base: Record<string, unknown>, show: boolean, id: string): Record<string, unknown> {
  if (!show) return base;
  return { kind: base.kind, id, ...base };
}

function annotateTargets(
  base: Record<string, unknown>,
  plans: ReadonlyMap<string, ResiliencePlan>,
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
