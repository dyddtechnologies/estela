import { randomBytes } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { IdempotencyRecord } from '../idempotency/idempotency-store';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import { PrivacyEngine, TrailOutput } from '../sensitive/privacy-engine';
import { Remember, type PrivacyModuleOptions } from '../sensitive/privacy.types';
import {
  PrivacyConfigError,
  ReplayUnavailableError,
  SealBrokenError,
  SealKeyUnavailableError,
} from '../sensitive/privacy-errors';
import { OUTCOME_ONLY_RECORD_KEY, SEALED_RECORD_KEY } from '../sensitive/sealed-record';
import type { SealKey } from '../sensitive/seal-key';
import { captureTrail } from '../testing/capture-trail';
import { expectNoLeak } from '../testing/expect-no-leak';
import { HttpExceptionFailureCodec } from './inbound.failure';
import {
  InboundIdempotencyGate,
  toStorePort,
  type InboundClaim,
  type InboundIdempotencyPlan,
  type InboundStoreSource,
} from './inbound.idempotency';
import type { InboundKeyContext, InboundSpec } from './inbound.types';
import { createInboundPlanner } from './inbound.plan';
import { inboundPrivacyGuard } from '../integration.privacy';

const TOKEN = 'CANARYTOKEN0001';
const SCOPE = 'inbound:pay';

interface Keys {
  down: boolean;
  byIdDown: boolean;
  retired: boolean;
  current(): Promise<SealKey>;
  byId(id: string): Promise<SealKey | undefined>;
}

function sealKeys(): Keys {
  const key: SealKey = { id: 'k1', key: randomBytes(32) };
  const keys: Keys = {
    down: false,
    byIdDown: false,
    retired: false,
    current: () => (keys.down ? Promise.reject(new Error('kms down')) : Promise.resolve(key)),
    byId: (id) => {
      if (keys.byIdDown) return Promise.reject(new Error('kms down'));
      return Promise.resolve(keys.retired || id !== key.id ? undefined : key);
    },
  };
  return keys;
}

/** A store that round-trips every record through JSON, like Redis (SD-35). */
class JsonStore implements InboundStoreSource {
  private readonly inner = new MemoryIdempotencyStore();
  begin = (scope: string, key: string, ttl: number): Promise<boolean> =>
    this.inner.begin(scope, key, ttl);
  complete = (scope: string, key: string, result: Record<string, unknown>): Promise<void> =>
    this.inner.complete(scope, key, JSON.parse(JSON.stringify(result)) as Record<string, unknown>);
  fail = (scope: string, key: string, error: unknown): Promise<void> =>
    this.inner.fail(scope, key, error);
  get = async (scope: string, key: string): Promise<IdempotencyRecord | undefined> => {
    const record = await this.inner.get(scope, key);
    return record === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(record)) as IdempotencyRecord);
  };
  release = (scope: string, key: string): Promise<unknown> => this.inner.release(scope, key);
}

async function plan(
  remember: Remember,
  options: { keys?: Keys; onDuplicate?: 'envelope' | 'replay'; store?: InboundStoreSource } = {},
): Promise<{ plan: InboundIdempotencyPlan; store: InboundStoreSource }> {
  const module: PrivacyModuleOptions = { remember };
  if (remember === Remember.Everything) module.rememberReason = 'test matrix';
  if (options.keys !== undefined) module.sealKeys = options.keys;
  const engine = await PrivacyEngine.compile(module, {
    [SCOPE]: { levels: [], durable: true },
  });
  const store = options.store ?? new MemoryIdempotencyStore();
  return {
    store,
    plan: {
      store: toStorePort(store),
      ttlMs: 60_000,
      scope: SCOPE,
      onDuplicate: options.onDuplicate ?? 'envelope',
      onInFlight: 'duplicate',
      failure: { mode: 'static', action: 'store' },
      codec: new HttpExceptionFailureCodec(),
      records: { engine, scope: SCOPE, codec: engine.recordCodec(SCOPE, TrailOutput.Store) },
    },
  };
}

const ctx = { clientKey: 'k-1', spec: { channel: 'pay' } } as unknown as InboundKeyContext;

async function acquired(
  gate: InboundIdempotencyGate,
  p: InboundIdempotencyPlan,
): Promise<InboundClaim> {
  const claim = await gate.claim(p, ctx);
  expect(claim.status).toBe('acquired');
  return claim;
}

async function repeat(gate: InboundIdempotencyGate, p: InboundIdempotencyPlan): Promise<unknown> {
  const claim = await gate.claim(p, ctx);
  if (claim.status !== 'repeat') throw new Error(`expected a repeat, got ${claim.status}`);
  return claim.repeat;
}

describe('S6 inbound records: remember matrix (8.2, SD-30 to SD-35)', () => {
  const gate = new InboundIdempotencyGate();
  const reply = { token: TOKEN, ok: true };

  it('matrix Everything: record, envelope and replay as in 0.9.0', async () => {
    const { plan: p, store } = await plan(Remember.Everything, { onDuplicate: 'replay' });
    await gate.succeed(await acquired(gate, p), { cachedResult: reply });
    expect((await store.get(SCOPE, 'k-1'))?.result).toEqual({ cachedResult: reply });
    expect(await repeat(gate, p)).toEqual({ kind: 'reply', result: reply });
  });

  it('matrix AsShown: hidden record, hidden envelope result', async () => {
    const capture = captureTrail();
    const { plan: p } = await plan(Remember.AsShown, {
      store: capture.store(new MemoryIdempotencyStore()),
    });
    await gate.succeed(await acquired(gate, p), { cachedResult: reply });
    expect(await repeat(gate, p)).toEqual({
      kind: 'duplicate',
      duplicateOf: 'completed',
      result: { token: '[HIDDEN:secrets.keys]', ok: true },
    });
    expectNoLeak(capture, [TOKEN]);
  });

  it('matrix Sealed: sealed record, decrypted replay, sealed stored failure', async () => {
    const capture = captureTrail();
    const keys = sealKeys();
    const { plan: p, store } = await plan(Remember.Sealed, {
      keys,
      onDuplicate: 'replay',
      store: capture.store(new MemoryIdempotencyStore()),
    });
    await gate.succeed(await acquired(gate, p), { cachedResult: reply });
    expect((await store.get(SCOPE, 'k-1'))?.result).toHaveProperty(SEALED_RECORD_KEY);
    expect(await repeat(gate, p)).toEqual({ kind: 'reply', result: reply });

    const failing = await plan(Remember.Sealed, { keys, onDuplicate: 'replay' });
    const claim = await acquired(gate, failing.plan);
    await gate.failed(claim, new HttpException({ token: TOKEN }, 402), ctx);
    expect((await failing.store.get(SCOPE, 'k-1'))?.result).toHaveProperty(SEALED_RECORD_KEY);
    const replayed = await gate.claim(failing.plan, ctx).catch((error: unknown) => error);
    expect(replayed).toBeInstanceOf(HttpException);
    expect((replayed as HttpException).getStatus()).toBe(402);
    expectNoLeak(capture, [TOKEN]);
  });

  it('matrix OutcomeOnly: marker record, null envelope result, status-only stored failure', async () => {
    const capture = captureTrail();
    const { plan: p } = await plan(Remember.OutcomeOnly, {
      store: capture.store(new MemoryIdempotencyStore()),
    });
    await gate.succeed(await acquired(gate, p), { cachedResult: reply });
    expect(capture.writes[0]?.text).toBe(JSON.stringify({ [OUTCOME_ONLY_RECORD_KEY]: { v: 1 } }));
    expect(await repeat(gate, p)).toEqual({
      kind: 'duplicate',
      duplicateOf: 'completed',
      result: null,
    });

    const failing = await plan(Remember.OutcomeOnly, {
      store: capture.store(new MemoryIdempotencyStore()),
    });
    const claim = await acquired(gate, failing.plan);
    await gate.failed(claim, new HttpException({ token: TOKEN }, 402), ctx);
    const replayed = await gate.claim(failing.plan, ctx).catch((error: unknown) => error);
    expect((replayed as HttpException).getStatus()).toBe(402);
    expectNoLeak(capture, [TOKEN]);
  });

  it('matrix keep: the fail record holds the hidden error, or only its name and code', async () => {
    for (const remember of [Remember.AsShown, Remember.OutcomeOnly]) {
      const capture = captureTrail();
      const { plan: p } = await plan(remember, {
        store: capture.store(new MemoryIdempotencyStore()),
      });
      p.failure = { mode: 'keep' };
      const claim = await acquired(gate, p);
      await gate.failed(
        claim,
        Object.assign(new Error(`denied token=${TOKEN}`), { code: 'E_DENIED' }),
        ctx,
      );
      const fail = capture.writes.find((w) => w.where.startsWith('store.fail'));
      expect(fail?.text).toContain('E_DENIED');
      expectNoLeak(capture, [TOKEN]);
    }
  });

  it('accepted records keep their ids for every remember value', async () => {
    const { plan: p, store } = await plan(Remember.OutcomeOnly, { onDuplicate: 'replay' });
    await gate.succeed(await acquired(gate, p), { accepted: true, id: 'm-1' });
    expect((await store.get(SCOPE, 'k-1'))?.result).toEqual({ accepted: true, id: 'm-1' });
    expect(await repeat(gate, p)).toEqual({ kind: 'accepted', acceptedId: 'm-1' });
  });

  it('outcome-only plus replay on request/reply fails boot', async () => {
    await expect(
      PrivacyEngine.compile(
        { fields: ['**.pan'] },
        { 'inbound:pay': { levels: [], durable: true, replays: true } },
      ),
    ).rejects.toBeInstanceOf(PrivacyConfigError);
    const keys = sealKeys();
    await expect(
      PrivacyEngine.compile(
        { fields: ['**.pan'], sealKeys: keys },
        {
          'inbound:pay': {
            levels: [
              { kind: 'endpoint', subject: "inbound 'pay'", ref: { remember: Remember.Sealed } },
            ],
            durable: true,
            replays: true,
          },
        },
      ),
    ).resolves.toBeInstanceOf(PrivacyEngine);
  });

  it('seal key provider down at claim fails closed before dispatch', async () => {
    const keys = sealKeys();
    const { plan: p, store } = await plan(Remember.Sealed, { keys });
    keys.down = true;
    const error = await gate.claim(p, ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SealKeyUnavailableError);
    expect((error as SealKeyUnavailableError).retryable).toBe(true);
    expect(await store.get(SCOPE, 'k-1')).toBeUndefined();
  });

  it('seal key provider down at replay never re-runs', async () => {
    const keys = sealKeys();
    const { plan: p } = await plan(Remember.Sealed, { keys, onDuplicate: 'replay' });
    await gate.succeed(await acquired(gate, p), { cachedResult: reply });
    keys.byIdDown = true;
    const error = await gate.claim(p, ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SealKeyUnavailableError);
  });

  it('retired seal key gives replay unavailable', async () => {
    const keys = sealKeys();
    const { plan: p } = await plan(Remember.Sealed, { keys, onDuplicate: 'replay' });
    await gate.succeed(await acquired(gate, p), { cachedResult: reply });
    keys.retired = true;
    const error = await gate.claim(p, ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplayUnavailableError);
    expect((error as ReplayUnavailableError).retryable).toBe(false);
  });

  it('a sealed record copied to another key raises SealBrokenError', async () => {
    const keys = sealKeys();
    const { plan: p, store } = await plan(Remember.Sealed, { keys, onDuplicate: 'replay' });
    await gate.succeed(await acquired(gate, p), { cachedResult: reply });
    const sealed = (await store.get(SCOPE, 'k-1'))?.result ?? {};
    await store.begin(SCOPE, 'k-2', 60_000);
    await store.complete(SCOPE, 'k-2', sealed);
    const error = await gate
      .claim(p, { ...ctx, clientKey: 'k-2' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SealBrokenError);
  });

  it('sealed and outcome-only records survive a JSON store', async () => {
    const keys = sealKeys();
    const sealed = await plan(Remember.Sealed, {
      keys,
      onDuplicate: 'replay',
      store: new JsonStore(),
    });
    await gate.succeed(await acquired(gate, sealed.plan), { cachedResult: reply });
    expect(await repeat(gate, sealed.plan)).toEqual({ kind: 'reply', result: reply });
    const outcome = await plan(Remember.OutcomeOnly, { store: new JsonStore() });
    await gate.succeed(await acquired(gate, outcome.plan), { cachedResult: reply });
    expect(await repeat(gate, outcome.plan)).toEqual({
      kind: 'duplicate',
      duplicateOf: 'completed',
      result: null,
    });
  });
});

describe('SD-44 endpoints that boot discovery skipped', () => {
  it('inbound policy missed by discovery is validated at first plan build', async () => {
    const engine = await PrivacyEngine.compile({ fields: ['**.pan'] });
    const errors: string[] = [];
    const logger = {
      log: () => undefined,
      warn: () => undefined,
      error: (m: string) => errors.push(m),
    };
    const guard = inboundPrivacyGuard(engine, [], undefined, logger);
    const store = new MemoryIdempotencyStore();
    const planner = createInboundPlanner({
      idempotency: store,
      privacy: engine,
      ensurePrivacy: guard,
    });
    const spec: InboundSpec = { channel: 'late', transport: 'rest', privacy: { fields: ['a..b'] } };
    expect(() => planner(spec)).toThrow(PrivacyConfigError);
    expect(() => planner(spec)).toThrow(PrivacyConfigError);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('inbound:late');

    const valid: InboundSpec = {
      channel: 'ok',
      transport: 'rest',
      privacy: { fields: ['**.cvv'] },
    };
    expect(planner(valid).idempotency?.records?.codec.remember).toBe(Remember.OutcomeOnly);
    expect(engine.hasScope('inbound:ok')).toBe(true);
  });
});
