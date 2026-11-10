import type { IntegrationMessage, MessageHeaders } from '../message';
import type { PrivacyLevel, PrivacyScope, PrivacyScopes } from '../sensitive/policy-resolver';
import type { PrivacyEngine } from '../sensitive/privacy-engine';
import { TrailOutput } from '../sensitive/privacy-engine';
import { PRIVACY_FINDING_CODES, type PrivacyFinding } from '../sensitive/privacy-errors';
import { envelopeBody, envelopeError, storedError } from '../trace/trail';
import { TapCopy, type FlowStep, type StepTrailPort } from './flow-step';
import type { BuiltFlow } from './integration-flow';
import { WireTapStep } from './steps/wire-tap.step';

/** Channel levels by channel name (L2), from the module's channel declarations. */
export type ChannelPrivacyLevels = (channel: string) => PrivacyLevel[];

const REASON_MAX = 200;

const flowScope = (flow: string): string => `flow:${flow}`;
const tapScope = (flow: string, index: number): string => `flow:${flow}#${index}`;

function sendChannels(step: FlowStep): string[] {
  const described = step.describe();
  const out: string[] = [];
  if (typeof described.channel === 'string') out.push(described.channel);
  for (const target of step.params?.targets ?? []) out.push(target.channel);
  return out;
}

/**
 * Privacy scopes of one flow (6.6). The flow scope unions the source channel and every channel a
 * step sends to (a union never weakens, D18); each wire tap gets the tap and source channels (D20).
 * Flow and step levels (L3, L4) join these scopes with the flow DSL references.
 */
export function flowPrivacyScopes(
  name: string,
  built: BuiltFlow,
  levelsOf: ChannelPrivacyLevels,
): PrivacyScopes {
  const scopes: Record<string, PrivacyScope> = {};
  const channels = new Set([built.source, ...built.steps.flatMap(sendChannels)]);
  scopes[flowScope(name)] = { levels: [...channels].flatMap(levelsOf) };
  for (const [index, step] of built.steps.entries()) {
    if (step instanceof WireTapStep) {
      const levels = [...levelsOf(step.channel), ...levelsOf(built.source)];
      scopes[tapScope(name, index)] = { levels };
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

/**
 * Resolves the wire-tap copies of a flow once its scopes are compiled (SD-28, SD-52): hidden by
 * default under explicit privacy, `TapCopy.Original` then needs a logged `copyReason`.
 */
export function resolveFlowPrivacy(
  engine: PrivacyEngine,
  name: string,
  built: BuiltFlow,
): FlowPrivacyResolution {
  const findings: PrivacyFinding[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const taps = new Map<number, TapPlan>();
  for (const [index, step] of built.steps.entries()) {
    if (!(step instanceof WireTapStep)) continue;
    const scope = tapScope(name, index);
    const explicit = engine.reaches({ scope });
    const { copy, copyReason } = step.tap;
    const stepId = step.params?.id ?? `wireTap#${index}`;
    const subject = `flow '${name}' step '${stepId}'`;
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
  return { privacy: new FlowPrivacy(engine, name, taps), findings, problems, notes };
}

function isReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= REASON_MAX;
}

/** Trail writers of one flow: error envelope, stored failure and per-step ports. */
export class FlowPrivacy {
  private readonly ports = new Map<number, StepTrailPort>();

  constructor(
    private readonly engine: PrivacyEngine,
    private readonly name: string,
    private readonly taps: ReadonlyMap<number, TapPlan>,
  ) {}

  /** S4: the flow envelope's `error`; the raw error unless an explicit privacy reaches the flow. */
  envelopeError(error: unknown): unknown {
    return envelopeError(this.engine, error, { scope: flowScope(this.name) });
  }

  /** S8: the error a flow `fail` record keeps (7.3). */
  storedError(error: unknown): unknown {
    return storedError(this.engine, error, { scope: flowScope(this.name) });
  }

  step(index: number): StepTrailPort {
    let port = this.ports.get(index);
    if (port === undefined) {
      port = this.portOf(this.taps.get(index));
      this.ports.set(index, port);
    }
    return port;
  }

  private portOf(tap: TapPlan | undefined): StepTrailPort {
    const engine = this.engine;
    const scope = flowScope(this.name);
    return {
      // The flow scope already unions every channel the flow sends to.
      envelopeBody: (body) => envelopeBody(engine, body, { scope }),
      tapCopy: (msg) => (tap?.shown === true ? shownCopy(engine, tap.scope, msg) : undefined),
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
