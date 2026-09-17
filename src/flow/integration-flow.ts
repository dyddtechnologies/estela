import type { IntegrationMessage } from '../message';
import type { FlowStep, FanoutDest, FanoutTargetInput } from './flow-step';
import { FanoutStep } from './steps/fanout.step';
import { FilterStep } from './steps/filter.step';
import { HandleStep } from './steps/handle.step';
import { JumpStep } from './steps/jump.step';
import { PublishStep } from './steps/publish.step';
import { ReplyStep, type ReplyOptions } from './steps/reply.step';
import { RouteStep } from './steps/route.step';
import { ToStep } from './steps/to.step';
import { TransformStep } from './steps/transform.step';
import { WireTapStep } from './steps/wire-tap.step';

export interface BuiltFlow {
  source: string;
  steps: readonly FlowStep[];
}

/** Definición declarativa consumida por `forRoot` (spec §6). */
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

/**
 * Builder fluido (GoF Builder — spec §6). Acumula steps; `build()` congela.
 * Los flows hablan con canales, no con clases (spec §17.1).
 */
export class IntegrationFlow {
  private readonly steps: FlowStep[] = [];

  private constructor(readonly source: string) {}

  static from(source: string): IntegrationFlow {
    return new IntegrationFlow(source);
  }

  filter(predicate: PredicateFn): this {
    this.steps.push(new FilterStep(predicate));
    return this;
  }

  transform(fn: MapFn): this {
    this.steps.push(new TransformStep(fn));
    return this;
  }

  handle(fn: MapFn): this {
    this.steps.push(new HandleStep(fn));
    return this;
  }

  wireTap(channel: string): this {
    this.steps.push(new WireTapStep(channel));
    return this;
  }

  fanoutTo(dests: readonly FanoutDest[]): this {
    this.steps.push(new FanoutStep(dests));
    return this;
  }

  jumpTo(dests: readonly FanoutDest[]): this {
    this.steps.push(new JumpStep(dests));
    return this;
  }

  jump(channel: string, opts?: { wait?: boolean; timeoutMs?: number }): this {
    const target: FanoutTargetInput = { channel };
    if (opts?.wait !== undefined) target.wait = opts.wait;
    if (opts?.timeoutMs !== undefined) target.timeoutMs = opts.timeoutMs;
    this.steps.push(new JumpStep([target]));
    return this;
  }

  publish(channel: string, routingKey?: string): this {
    this.steps.push(new PublishStep(channel, routingKey));
    return this;
  }

  route(fn: RouteFn): this {
    this.steps.push(new RouteStep(fn));
    return this;
  }

  to(channel: string): this {
    this.steps.push(new ToStep(channel));
    return this;
  }

  reply(options?: ReplyOptions): this {
    this.steps.push(new ReplyStep(options));
    return this;
  }

  /** Sin funciones (plan §9.4) — alimenta `inspect()` y el grafo (Fase 9). */
  inspect(): { source: string; steps: Record<string, unknown>[] } {
    return { source: this.source, steps: this.steps.map((step) => step.describe()) };
  }

  build(): BuiltFlow {
    return { source: this.source, steps: [...this.steps] };
  }
}
