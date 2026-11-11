import { PrivacyEngine, TrailOutput, type TrailContext } from '../sensitive/privacy-engine';
import { Remember } from '../sensitive/privacy.types';

/**
 * Trail writers shared by the edges (SPI-433, 7.2). Every place where Estela itself writes a value
 * outside the live call goes through one of these helpers, so a writer never picks its own rules.
 */

type Where = Omit<TrailContext, 'output'>;

let baseline: PrivacyEngine | undefined;

/** The baseline of a writer built without a module engine (section 2, D3). */
export function trailEngine(engine?: PrivacyEngine): PrivacyEngine {
  if (engine !== undefined) return engine;
  baseline ??= PrivacyEngine.baseline();
  return baseline;
}

export interface LoggedError {
  /** `Name: message`, or the text of a thrown value that is not an Error. */
  reason: string;
  message: string;
  stack: string | undefined;
}

/** S1, S2: an error as an error-level log line prints it; the baseline applies without a module. */
export function errorForLog(
  engine: PrivacyEngine | undefined,
  error: unknown,
  where: Where = {},
): LoggedError {
  const writer = trailEngine(engine);
  if (!(error instanceof Error)) {
    const text = writer.off ? String(error) : writer.textForTrail(String(error), log(where));
    return { reason: text, message: text, stack: undefined };
  }
  if (writer.off) {
    return {
      reason: `${error.name}: ${error.message}`,
      message: error.message,
      stack: error.stack,
    };
  }
  const shaped = writer.errorForTrail(error, log(where));
  const stack = typeof shaped.stack === 'string' ? shaped.stack : undefined;
  return { reason: `${shaped.name}: ${shaped.message}`, message: shaped.message, stack };
}

/** S5, S15: free text of a log line. */
export function textForLog(engine: PrivacyEngine | undefined, text: string, where: Where = {}) {
  const writer = trailEngine(engine);
  return writer.off ? text : writer.textForTrail(text, log(where));
}

/** S4: the body of an error envelope; hidden only when an explicit privacy reaches the writer. */
export function envelopeBody(
  engine: PrivacyEngine | undefined,
  body: unknown,
  where: Where,
): unknown {
  if (engine?.reaches(where) !== true) return body;
  return engine.forTrail(body, { ...where, output: TrailOutput.ErrorEnvelope });
}

/** S4: the raw error a flow envelope carries, as `errorForTrail` shows it under explicit privacy. */
export function envelopeError(
  engine: PrivacyEngine | undefined,
  error: unknown,
  where: Where,
): unknown {
  if (engine?.reaches(where) !== true) return error;
  return engine.errorForTrail(error, { ...where, output: TrailOutput.ErrorEnvelope });
}

/**
 * S6 to S8 `fail` records (7.3): an Error whose name and message are the hidden ones, never the
 * plain object `errorForTrail` returns, so a store that keeps `{ name, message }` never wraps it.
 * `remember` undefined is a flow scope: hidden when an explicit privacy reaches it.
 */
export function storedError(
  engine: PrivacyEngine | undefined,
  error: unknown,
  where: Where,
  remember?: Remember,
): unknown {
  if (engine === undefined) return error;
  const keep = remember === undefined ? !engine.reaches(where) : remember === Remember.Everything;
  if (keep) return error;
  const shaped = engine.errorForTrail(error, { ...where, output: TrailOutput.Store });
  const code = typeof shaped.code === 'string' ? shaped.code : undefined;
  const message = remember === Remember.OutcomeOnly ? (code ?? '') : shaped.message;
  const stored = new Error(message);
  stored.name = shaped.name;
  delete stored.stack;
  if (code !== undefined) Object.assign(stored, { code });
  return stored;
}

/** S3: the default `error.channel` line (SD-04); never `JSON.stringify` on a raw error. */
export function errorChannelText(engine: PrivacyEngine, payload: unknown): string {
  const where: Where = {};
  const channel = (payload as { channel?: unknown } | null)?.channel;
  if (typeof channel === 'string') where.channel = channel;
  const shaped = withErrorsShaped(payload, (error) => errorEntry(engine, error, where));
  const copy = engine.off ? shaped : engine.forTrail(shaped, log(where));
  return jsonText(copy);
}

function errorEntry(engine: PrivacyEngine, error: Error, where: Where): Record<string, unknown> {
  const entry: Record<string, unknown> = { ...engine.errorForTrail(error, log(where)) };
  delete entry.stack;
  return entry;
}

function withErrorsShaped(
  payload: unknown,
  shape: (error: Error) => Record<string, unknown>,
): unknown {
  if (payload instanceof Error) return shape(payload);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  const entries = Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
    key,
    value instanceof Error ? shape(value) : value,
  ]);
  return Object.fromEntries(entries);
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    );
  } catch {
    return '[unprintable]';
  }
}

function log(where: Where): TrailContext {
  return { ...where, output: TrailOutput.Log };
}
