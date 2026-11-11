import type { IntegrationMessage } from '../message';
import {
  FLOW_SHAPE_CODES,
  FlowDefinitionError,
  flowFinding,
  type FlowParameterFinding,
} from './flow-definition-error';
import {
  normalizeDests,
  type FanoutTargetInput,
  type FlowDest,
  type FlowOptions,
  type FlowStep,
  type FlowTarget,
  type JumpOptions,
  type CareStepOptions,
  type StepCommonOptions,
  type StepParams,
  type TapCopy,
} from './flow-step';
import { FanoutStep } from './steps/fanout.step';
import {
  FilterStep,
  type DropReplyFn,
  type DropReplyValue,
  type FilterWhenDropped,
} from './steps/filter.step';
import { HandleStep } from './steps/handle.step';
import {
  HeadersStep,
  reservedNamesOf,
  type HeaderValues,
  type HeadersFn,
} from './steps/headers.step';
import { JumpStep } from './steps/jump.step';
import { PublishStep } from './steps/publish.step';
import { ReplyStep, type ReplyOptions } from './steps/reply.step';
import { RouteStep } from './steps/route.step';
import { ToStep } from './steps/to.step';
import { TransformStep } from './steps/transform.step';
import { WireTapStep, type TapCopyOptions } from './steps/wire-tap.step';

export interface BuiltFlow {
  source: string;
  steps: readonly FlowStep[];
  /** Flow-level parameters (L3); absent when `from(source)` got none. */
  options?: FlowOptions;
}

/** Declarative definition consumed by `forRoot` (spec sec.6). */
export interface FlowDefinition {
  name: string;
  build(): IntegrationFlow;
}

export type PredicateFn = (payload: unknown, msg: IntegrationMessage) => boolean | Promise<boolean>;
export type MapFn = (payload: unknown, msg: IntegrationMessage) => unknown;
export type RouteFn = (
  payload: unknown,
  msg: IntegrationMessage,
) => string | string[] | Promise<string | string[]>;

export type { HeaderValues, HeadersFn, DropReplyFn, DropReplyValue, FilterWhenDropped };

/** Options of `filter`; care is never accepted there (RS-58). */
export interface FilterOptions extends StepCommonOptions {
  /** Answer the caller when the message is dropped; absent = silent drop (0.9.0). */
  whenDropped?: FilterWhenDropped;
}

/**
 * Options of `wireTap`; care is never accepted there (RS-58). `copy` says what the tap delivers
 * (SPI-433, SD-52): `TapCopy.AsShown` by default once an explicit privacy reaches the tap;
 * `TapCopy.Original` then needs `copyReason` (1..200 chars, logged at boot).
 */
export type WireTapOptions = StepCommonOptions & { copy?: TapCopy; copyReason?: string };

function hasReply(whenDropped: unknown): boolean {
  return (
    typeof whenDropped === 'object' && whenDropped !== null && Object.hasOwn(whenDropped, 'reply')
  );
}

/** Effective id of the step at `index` (RS-57). */
export function stepIdOf(step: FlowStep, index: number): string {
  return step.params?.id ?? `${step.kind}#${index}`;
}

function paramsOf(
  opts: StepCommonOptions | undefined,
  care: CareStepOptions['care'],
  targets?: readonly FlowTarget[],
): StepParams {
  const params: { -readonly [K in keyof StepParams]: StepParams[K] } = {};
  if (opts?.id !== undefined) params.id = opts.id;
  if (opts?.privacy !== undefined) params.privacy = opts.privacy;
  if (care !== undefined) params.care = care;
  if (targets !== undefined) params.targets = targets;
  return params;
}

/**
 * Fluent builder (GoF Builder, spec sec.6). It collects steps; `build()` freezes them.
 * Flows talk to channels, never to classes (spec sec.17.1).
 */
export class IntegrationFlow {
  private readonly steps: FlowStep[] = [];
  private readonly findings: FlowParameterFinding[] = [];

  private constructor(
    readonly source: string,
    private readonly options?: FlowOptions,
  ) {}

  static from(source: string, options?: FlowOptions): IntegrationFlow {
    return new IntegrationFlow(source, options);
  }

  /**
   * Drops the messages `predicate` refuses. `whenDropped.reply` answers the caller of a dropped
   * message (its `replyChannel`) with a fixed value or `reply(payload, msg)`; without it the drop
   * is silent and a request/reply caller waits until its timeout.
   */
  filter(predicate: PredicateFn, opts?: FilterOptions): this {
    this.refuseCare('filter', opts);
    const whenDropped = opts?.whenDropped;
    if (whenDropped !== undefined && !hasReply(whenDropped)) {
      const id = opts?.id ?? `filter#${this.steps.length}`;
      this.findings.push(
        flowFinding(
          `step '${id}'`,
          'whenDropped.reply',
          FLOW_SHAPE_CODES.dropReplyMissing,
          'is required',
        ),
      );
    }
    return this.push(new FilterStep(predicate, paramsOf(opts, undefined), whenDropped));
  }

  transform(fn: MapFn, opts?: StepCommonOptions): this {
    this.refuseCare('transform', opts);
    return this.push(new TransformStep(fn, paramsOf(opts, undefined)));
  }

  /**
   * Header enricher: merges `values` (or what `values(payload, msg)` returns) into the message
   * headers. Reserved names (`RESERVED_HEADER_NAMES`) are refused: a fixed object fails
   * `build()`, a function fails the run with `FlowHeadersError`. `undefined` values are skipped.
   */
  headers(values: HeaderValues | HeadersFn, opts?: StepCommonOptions): this {
    this.refuseCare('headers', opts);
    const params = paramsOf(opts, undefined);
    if (typeof values === 'function') return this.push(new HeadersStep(values, params));
    const fixed: HeaderValues = { ...values };
    const id = opts?.id ?? `headers#${this.steps.length}`;
    for (const name of reservedNamesOf(fixed)) {
      this.findings.push(
        flowFinding(
          `step '${id}'`,
          `headers.${name}`,
          FLOW_SHAPE_CODES.reservedHeader,
          'is a reserved header and cannot be set by a flow',
        ),
      );
    }
    return this.push(new HeadersStep(fixed, params));
  }

  handle(fn: MapFn, opts?: CareStepOptions): this {
    return this.push(new HandleStep(fn, paramsOf(opts, opts?.care)));
  }

  wireTap(channel: string, opts?: WireTapOptions): this {
    this.refuseCare('wireTap', opts);
    const tap: TapCopyOptions = {};
    if (opts?.copy !== undefined) tap.copy = opts.copy;
    if (opts?.copyReason !== undefined) tap.copyReason = opts.copyReason;
    return this.push(new WireTapStep(channel, paramsOf(opts, undefined), tap));
  }

  fanoutTo(dests: readonly FlowDest[], opts?: CareStepOptions): this {
    const params = paramsOf(opts, opts?.care, normalizeDests(dests));
    return this.push(new FanoutStep(dests, params));
  }

  jumpTo(dests: readonly FlowDest[], opts?: CareStepOptions): this {
    const params = paramsOf(opts, opts?.care, normalizeDests(dests));
    return this.push(new JumpStep(dests, undefined, params));
  }

  jump(channel: string, opts?: JumpOptions): this {
    const target: FanoutTargetInput = { channel };
    if (opts?.wait !== undefined) target.wait = opts.wait;
    if (opts?.timeoutMs !== undefined) target.timeoutMs = opts.timeoutMs;
    const params = paramsOf(opts, opts?.care, [target]);
    return this.push(new JumpStep([target], undefined, params));
  }

  publish(channel: string, routingKey?: string, opts?: CareStepOptions): this;
  publish(channel: string, opts: CareStepOptions): this;
  publish(channel: string, second?: string | CareStepOptions, third?: CareStepOptions): this {
    // A string second argument is the routing key (RS-57 overload).
    const routingKey = typeof second === 'string' ? second : undefined;
    const opts = typeof second === 'object' ? second : third;
    const params = paramsOf(opts, opts?.care, [{ channel }]);
    return this.push(new PublishStep(channel, routingKey, params));
  }

  route(fn: RouteFn, opts?: CareStepOptions): this {
    return this.push(new RouteStep(fn, paramsOf(opts, opts?.care)));
  }

  to(channel: string, opts?: CareStepOptions): this {
    return this.push(new ToStep(channel, paramsOf(opts, opts?.care, [{ channel }])));
  }

  /** `reply` takes an id only: the reply is the caller's data and has no privacy (18.3). */
  reply(options?: ReplyOptions & Pick<StepCommonOptions, 'id'>): this {
    this.refuseCare('reply', options);
    const { id, ...replyOptions } = options ?? {};
    const params = paramsOf(id === undefined ? undefined : { id }, undefined);
    return this.push(new ReplyStep(options === undefined ? undefined : replyOptions, params));
  }

  /** No functions (plan sec.9.4); feeds `inspect()` and the graph. */
  inspect(): { source: string; steps: Record<string, unknown>[] } {
    return { source: this.source, steps: this.steps.map((step) => step.describe()) };
  }

  /**
   * Freezes the flow. Shape errors collected by the builder and duplicate step ids fail here
   * with one `FlowDefinitionError` listing every finding (RS-57, RS-58).
   */
  build(): BuiltFlow {
    const findings = [...this.findings, ...this.duplicateIds()];
    if (findings.length > 0) throw new FlowDefinitionError(findings);
    const built: BuiltFlow = { source: this.source, steps: [...this.steps] };
    if (this.options !== undefined) built.options = this.options;
    return built;
  }

  private push(step: FlowStep): this {
    this.steps.push(step);
    return this;
  }

  private duplicateIds(): FlowParameterFinding[] {
    const seen = new Set<string>();
    const findings: FlowParameterFinding[] = [];
    this.steps.forEach((step, index) => {
      const id = stepIdOf(step, index);
      if (seen.has(id)) {
        findings.push(
          flowFinding(
            `step '${id}'`,
            'id',
            FLOW_SHAPE_CODES.duplicateStepId,
            'is used by another step of this flow',
          ),
        );
      }
      seen.add(id);
    });
    return findings;
  }

  /** RS-57, RS-58: a JavaScript caller can still pass `care` where the type refuses it. */
  private refuseCare(
    kind: 'filter' | 'transform' | 'headers' | 'reply' | 'wireTap',
    opts: unknown,
  ): void {
    const value = (opts as { care?: unknown } | undefined)?.care;
    if (value === undefined) return;
    const id = (opts as { id?: string }).id ?? `${kind}#${this.steps.length}`;
    const wiretap = kind === 'wireTap';
    this.findings.push(
      flowFinding(
        `step '${id}'`,
        'care',
        wiretap ? FLOW_SHAPE_CODES.wiretapCare : FLOW_SHAPE_CODES.carePartNotAllowed,
        wiretap ? 'is never accepted on wireTap' : `is not accepted on ${kind}`,
      ),
    );
  }
}
