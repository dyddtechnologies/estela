import { isReservedHeader, type IntegrationMessage } from '../../message';
import {
  FlowHeadersError,
  type FlowStep,
  type FlowStepContext,
  type StepOutcome,
  type StepParams,
} from '../flow-step';

/** Headers a `headers` step merges; an `undefined` value is skipped. */
export type HeaderValues = Readonly<Record<string, unknown>>;

/** Computes the headers to merge from the current payload and message. */
export type HeadersFn = (
  payload: unknown,
  msg: IntegrationMessage,
) => HeaderValues | Promise<HeaderValues>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Reserved names among `values`, sorted (fixed objects are refused at build time). */
export function reservedNamesOf(values: HeaderValues): string[] {
  return Object.keys(values)
    .filter((name) => isReservedHeader(name))
    .sort((a, b) => a.localeCompare(b));
}

function checked(out: unknown): Record<string, unknown> {
  if (!isPlainObject(out)) {
    throw new FlowHeadersError('headers step: the function must return a plain object');
  }
  const reserved = reservedNamesOf(out);
  if (reserved.length > 0) {
    throw new FlowHeadersError(
      `headers step: reserved header(s) cannot be set by a flow: ${reserved.join(', ')}`,
      reserved,
    );
  }
  return out;
}

/**
 * Header enricher (EIP): merges custom headers into the message; payload, id and trace stay.
 * It records no hop. Later steps, care key functions and activators read the merged headers.
 */
export class HeadersStep implements FlowStep {
  readonly kind = 'headers' as const;

  constructor(
    private readonly source: HeaderValues | HeadersFn,
    readonly params?: StepParams,
  ) {}

  /** Names only, never values; a function shows as `computed`. */
  describe(): Record<string, unknown> {
    if (typeof this.source === 'function') return { kind: this.kind, computed: true };
    const names = Object.keys(this.source).sort((a, b) => a.localeCompare(b));
    return { kind: this.kind, names };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const values =
      typeof this.source === 'function'
        ? checked(await this.source(ctx.msg.payload, ctx.msg))
        : this.source;
    const defined = Object.entries(values).filter(([, value]) => value !== undefined);
    if (defined.length === 0) return { action: 'continue', msg: ctx.msg };
    const headers = { ...ctx.msg.headers, ...Object.fromEntries(defined) };
    return { action: 'continue', msg: { payload: ctx.msg.payload, headers } };
  }
}
