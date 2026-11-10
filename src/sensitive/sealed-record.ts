import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Remember } from './privacy.types';
import { ReplayUnavailableError, SealBrokenError, SealKeyUnavailableError } from './privacy-errors';
import type { SealKey, SealKeyProvider } from './seal-key';

export const SEALED_RECORD_KEY = 'estelaSealed';
export const OUTCOME_ONLY_RECORD_KEY = 'estelaOutcomeOnly';

export interface RecordCodec {
  readonly remember: Remember;
  /** Called before the claim. Remember.Sealed: fetches SealKeyProvider.current() (SD-32); others: no I/O. */
  prepare(): Promise<RecordSealer>;
  /** Inverse on read; Remember.OutcomeOnly yields { outcomeOnly: true }. byId() failures per SD-32. */
  decode(
    scope: string,
    key: string,
    stored: Record<string, unknown>,
  ): Promise<Record<string, unknown> | { outcomeOnly: true }>;
}

/** Holds the seal key fetched by prepare(); encode is CPU-only (safe inside a transaction). */
export interface RecordSealer {
  encode(scope: string, key: string, record: Record<string, unknown>): Record<string, unknown>;
}

/** `{ estelaSealed: { v: 1, kid, iv, tag, ct } }`, base64 fields (SD-31). */
interface SealedEnvelope {
  v: 1;
  kid: string;
  iv: string;
  tag: string;
  ct: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** AAD binds a record to its storage key, so a copied record never opens (I3). */
function aad(scope: string, key: string): Buffer {
  return Buffer.from(`estela:v1:${scope}::${key}`, 'utf8');
}

function usableKey(material: SealKey | undefined): material is SealKey {
  return (
    material !== undefined &&
    typeof material.id === 'string' &&
    material.id !== '' &&
    material.key instanceof Uint8Array &&
    material.key.byteLength === KEY_BYTES
  );
}

/** AES-256-GCM with a random 96-bit IV. */
export function seal(
  material: SealKey,
  scope: string,
  key: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, material.key, iv);
  cipher.setAAD(aad(scope, key));
  const ct = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
  const envelope: SealedEnvelope = {
    v: 1,
    kid: material.id,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return { [SEALED_RECORD_KEY]: envelope };
}

function envelopeOf(stored: Record<string, unknown>): SealedEnvelope | undefined {
  const value = stored[SEALED_RECORD_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  return value as SealedEnvelope;
}

/** Inverse of `seal`; throws SealBrokenError when authentication fails. */
export function open(
  material: SealKey,
  scope: string,
  key: string,
  envelope: SealedEnvelope,
): Record<string, unknown> {
  try {
    const decipher = createDecipheriv(ALGORITHM, material.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(aad(scope, key));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.ct, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new SealBrokenError(scope);
  }
}

const keepRecord: RecordSealer['encode'] = (_scope, _key, record) => record;

export interface RecordCodecDeps {
  /** The scope name used in error messages. */
  readonly scope: string;
  readonly sealKeys?: SealKeyProvider | undefined;
  /** `Remember.AsShown`: the trail copy of a record (the engine's `forTrail` with output store). */
  readonly asShown?: ((record: Record<string, unknown>) => unknown) | undefined;
}

function sealedCodec(deps: RecordCodecDeps): RecordCodec {
  const provider = deps.sealKeys;
  return {
    remember: Remember.Sealed,
    async prepare(): Promise<RecordSealer> {
      let material: SealKey | undefined;
      try {
        material = await provider?.current();
      } catch (error) {
        throw new SealKeyUnavailableError(deps.scope, error);
      }
      if (!usableKey(material)) throw new SealKeyUnavailableError(deps.scope);
      const current = material;
      return { encode: (scope, key, record) => seal(current, scope, key, record) };
    },
    async decode(scope, key, stored) {
      const envelope = envelopeOf(stored);
      if (envelope === undefined) return stored;
      if (envelope.v !== 1 || typeof envelope.kid !== 'string') throw new SealBrokenError(scope);
      let material: SealKey | undefined;
      try {
        material = await provider?.byId(envelope.kid);
      } catch (error) {
        throw new SealKeyUnavailableError(scope, error);
      }
      if (material === undefined) throw new ReplayUnavailableError(scope, 'retired seal key');
      if (!usableKey(material)) throw new SealKeyUnavailableError(scope);
      return open(material, scope, key, envelope);
    },
  };
}

function plainCodec(remember: Remember, encode: RecordSealer['encode']): RecordCodec {
  const sealer: RecordSealer = { encode };
  return {
    remember,
    prepare: () => Promise.resolve(sealer),
    decode: (_scope, _key, stored) => {
      if (stored[OUTCOME_ONLY_RECORD_KEY] !== undefined) {
        return Promise.resolve({ outcomeOnly: true as const });
      }
      return Promise.resolve(stored);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

/** The codec of one `Remember` value (4.6, 8.2). It sits above the store (D13). */
export function createRecordCodec(remember: Remember, deps: RecordCodecDeps): RecordCodec {
  switch (remember) {
    case Remember.Sealed:
      return sealedCodec(deps);
    case Remember.OutcomeOnly:
      return plainCodec(remember, () => ({ [OUTCOME_ONLY_RECORD_KEY]: { v: 1 } }));
    case Remember.AsShown: {
      const asShown = deps.asShown;
      if (asShown === undefined) {
        return plainCodec(remember, () => ({ [OUTCOME_ONLY_RECORD_KEY]: { v: 1 } }));
      }
      return plainCodec(remember, (_scope, _key, record) => asRecord(asShown(record)));
    }
    default:
      return plainCodec(remember, keepRecord);
  }
}
