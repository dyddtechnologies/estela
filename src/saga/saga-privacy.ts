import { withRemember } from '../integration.privacy';
import { PrivacyEngine, TrailOutput } from '../sensitive/privacy-engine';
import { PrivacyConfigError, ReplayUnavailableError } from '../sensitive/privacy-errors';
import { Remember, type PrivacyRef } from '../sensitive/privacy.types';
import type { PrivacyScopes } from '../sensitive/policy-resolver';
import type { RecordCodec, RecordSealer } from '../sensitive/sealed-record';
import type { SealKeyProvider } from '../sensitive/seal-key';

/** `SagaRunnerOptions.privacy` (SPI-433, 4.8): what the ledger remembers and the error lines show. */
export interface SagaPrivacyOptions {
  /** Rules of the runner; profile names resolve only with `engine` (SD-63). */
  rules?: PrivacyRef;
  /** Default `Remember.OutcomeOnly` once a rule reaches the runner, else `Remember.Everything`. */
  remember?: Remember;
  /** Seal keys of `Remember.Sealed`; default the engine's module `sealKeys`. */
  sealKeys?: SealKeyProvider;
  /** The module engine (inject `PrivacyEngine`): its module rules and profiles apply too. */
  engine?: PrivacyEngine;
  /** Answer of an outcome-only replay; without it the replay throws ReplayUnavailableError. */
  replyOnReplay?: (ctx: unknown) => unknown;
}

/** The ledger value of a reply under any `remember` other than `Remember.Everything`. */
const REPLY_KEY = 'estelaReply';

let runners = 0;

/** Ledger codec and log engine of one saga runner (SD-29, SD-33, D7). */
export class SagaPrivacy {
  readonly engine: PrivacyEngine | undefined;
  /** The runner's scope in `engine`: its error lines and ledger rows use the runner's rules. */
  readonly scope: string | undefined;
  private readonly codec: RecordCodec | undefined;

  constructor(private readonly options?: SagaPrivacyOptions) {
    if (options === undefined) {
      this.engine = undefined;
      this.scope = undefined;
      this.codec = undefined;
      return;
    }
    runners++;
    const scope = `saga-runner#${runners}`;
    this.scope = scope;
    const scopes: PrivacyScopes = {
      [scope]: {
        levels: [
          {
            kind: 'saga',
            subject: 'saga runner',
            ref: withRemember(options.rules, options.remember),
          },
        ],
        durable: true,
      },
    };
    this.engine = compileRunner(options, scopes);
    const remember = this.engine.rememberOf(scope);
    this.codec =
      remember === Remember.Everything
        ? undefined
        : this.engine.recordCodec(scope, TrailOutput.Ledger, options.sealKeys ?? undefined);
  }

  /** Before the first unit of work: the seal key never travels inside a transaction (I9). */
  async prepare(): Promise<RecordSealer | undefined> {
    return this.codec?.prepare();
  }

  /** Inside the unit's transaction: CPU only. */
  encode(sealer: RecordSealer | undefined, saga: string, key: string, reply: unknown): unknown {
    if (sealer === undefined) return reply;
    return sealer.encode(saga, key, { [REPLY_KEY]: reply });
  }

  /** After the claim's unit: decodes a stored reply; an outcome-only record never re-runs (I4). */
  async replay(saga: string, key: string, stored: unknown, ctx: unknown): Promise<unknown> {
    const codec = this.codec;
    if (codec === undefined || typeof stored !== 'object' || stored === null) return stored;
    const decoded = await codec.decode(saga, key, stored as Record<string, unknown>);
    if ('outcomeOnly' in decoded && decoded.outcomeOnly === true) {
      const answer = this.options?.replyOnReplay;
      if (answer === undefined) throw new ReplayUnavailableError(saga, 'outcome-only record');
      return answer(ctx);
    }
    return REPLY_KEY in decoded ? decoded[REPLY_KEY] : decoded;
  }
}

function compileRunner(options: SagaPrivacyOptions, scopes: PrivacyScopes): PrivacyEngine {
  const engine = options.engine;
  if (engine === undefined) {
    const sealKeys = options.sealKeys;
    return PrivacyEngine.compileSync(sealKeys === undefined ? undefined : { sealKeys }, scopes);
  }
  const result = engine.addScopes(scopes, { sealKeys: options.sealKeys !== undefined });
  if (result.findings.length > 0) throw new PrivacyConfigError(result.problems, result.findings);
  return engine;
}
