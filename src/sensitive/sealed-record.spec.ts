import { Remember } from './privacy.types';
import { ReplayUnavailableError, SealBrokenError, SealKeyUnavailableError } from './privacy-errors';
import { createRecordCodec, OUTCOME_ONLY_RECORD_KEY, SEALED_RECORD_KEY } from './sealed-record';
import type { SealKey, SealKeyProvider } from './seal-key';

const K1: SealKey = { id: 'k1', key: Buffer.alloc(32, 1) };
const K2: SealKey = { id: 'k2', key: Buffer.alloc(32, 2) };

function provider(
  keys: SealKey[] = [K1, K2],
  current: SealKey = K1,
): SealKeyProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    current: () => {
      calls.push('current');
      return Promise.resolve(current);
    },
    byId: (id) => {
      calls.push(`byId:${id}`);
      return Promise.resolve(keys.find((k) => k.id === id));
    },
  };
}

const record = { cachedResult: { pan: '4111111111111111', amount: 10 } };
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('records by remember value (4.6, 8.2)', () => {
  it('I3 / SD-31 sealed records: round trip, tamper, key swap', async () => {
    const codec = createRecordCodec(Remember.Sealed, {
      scope: 'inbound:pay',
      sealKeys: provider(),
    });
    const sealer = await codec.prepare();
    const stored = sealer.encode('inbound:pay', 'K-1', record);
    expect(Object.keys(stored)).toEqual([SEALED_RECORD_KEY]);
    expect(JSON.stringify(stored)).not.toContain('4111');
    expect(stored[SEALED_RECORD_KEY]).toMatchObject({ v: 1, kid: 'k1' });
    await expect(codec.decode('inbound:pay', 'K-1', stored)).resolves.toEqual(record);
    await expect(codec.decode('inbound:pay', 'K-2', stored)).rejects.toBeInstanceOf(
      SealBrokenError,
    );
    await expect(codec.decode('inbound:other', 'K-1', stored)).rejects.toBeInstanceOf(
      SealBrokenError,
    );
    const envelope = { ...(stored[SEALED_RECORD_KEY] as Record<string, string>) };
    const ct = Buffer.from(envelope.ct!, 'base64');
    ct[0] = ct[0]! ^ 1;
    const tampered = { [SEALED_RECORD_KEY]: { ...envelope, ct: ct.toString('base64') } };
    const error = await codec.decode('inbound:pay', 'K-1', tampered).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SealBrokenError);
    expect((error as SealBrokenError).retryable).toBe(false);
    const otherKid = { [SEALED_RECORD_KEY]: { ...envelope, kid: 'k2' } };
    await expect(codec.decode('inbound:pay', 'K-1', otherKid)).rejects.toBeInstanceOf(
      SealBrokenError,
    );
    const accepted = { accepted: true, id: 'm-1' };
    await expect(codec.decode('inbound:pay', 'K-1', accepted)).resolves.toBe(accepted);
  });

  it('SD-32 seal key provider down at claim fails closed before dispatch', async () => {
    const down: SealKeyProvider = {
      current: () => Promise.reject(new Error('kms down with key material')),
      byId: () => Promise.resolve(undefined),
    };
    const codec = createRecordCodec(Remember.Sealed, { scope: 'inbound:pay', sealKeys: down });
    const error = (await codec.prepare().catch((e: unknown) => e)) as SealKeyUnavailableError;
    expect(error).toBeInstanceOf(SealKeyUnavailableError);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('SEAL_KEY_UNAVAILABLE: inbound:pay');
    const short = createRecordCodec(Remember.Sealed, {
      scope: 's',
      sealKeys: {
        current: () => Promise.resolve({ id: 'x', key: Buffer.alloc(16) }),
        byId: () => Promise.resolve(undefined),
      },
    });
    await expect(short.prepare()).rejects.toBeInstanceOf(SealKeyUnavailableError);
  });

  it('I4 / SD-32 seal key provider down at replay never re-runs', async () => {
    const sealer = await createRecordCodec(Remember.Sealed, {
      scope: 's',
      sealKeys: provider(),
    }).prepare();
    const stored = sealer.encode('s', 'k', record);
    const down: SealKeyProvider = {
      current: () => Promise.resolve(K1),
      byId: () => Promise.reject(new Error('kms down')),
    };
    const codec = createRecordCodec(Remember.Sealed, { scope: 's', sealKeys: down });
    const error = await codec.decode('s', 'k', stored).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SealKeyUnavailableError);
  });

  it('SD-32 retired seal key gives replay unavailable', async () => {
    const sealer = await createRecordCodec(Remember.Sealed, {
      scope: 's',
      sealKeys: provider([K2], K2),
    }).prepare();
    const stored = sealer.encode('s', 'k', record);
    const codec = createRecordCodec(Remember.Sealed, { scope: 's', sealKeys: provider([K1]) });
    const error = (await codec
      .decode('s', 'k', stored)
      .catch((e: unknown) => e)) as ReplayUnavailableError;
    expect(error).toBeInstanceOf(ReplayUnavailableError);
    expect(error.retryable).toBe(false);
  });

  it('I9 / SD-33 the sealer never calls the seal key provider', async () => {
    const keys = provider();
    const sealer = await createRecordCodec(Remember.Sealed, {
      scope: 's',
      sealKeys: keys,
    }).prepare();
    expect(keys.calls).toEqual(['current']);
    for (let i = 0; i < 3; i++) sealer.encode('s', `k${i}`, record);
    expect(keys.calls).toEqual(['current']);
  });

  it('SD-35 sealed and outcome-only records survive a JSON store', async () => {
    const sealed = createRecordCodec(Remember.Sealed, { scope: 's', sealKeys: provider() });
    const stored = json((await sealed.prepare()).encode('s', 'k', record));
    await expect(sealed.decode('s', 'k', stored)).resolves.toEqual(record);
    const outcome = createRecordCodec(Remember.OutcomeOnly, { scope: 's' });
    const marker = json((await outcome.prepare()).encode('s', 'k', record));
    expect(marker).toEqual({ [OUTCOME_ONLY_RECORD_KEY]: { v: 1 } });
    await expect(outcome.decode('s', 'k', marker)).resolves.toEqual({ outcomeOnly: true });
  });

  it('Everything keeps the record and AsShown stores the trail copy', async () => {
    const everything = createRecordCodec(Remember.Everything, { scope: 's' });
    expect((await everything.prepare()).encode('s', 'k', record)).toBe(record);
    const asShown = createRecordCodec(Remember.AsShown, {
      scope: 's',
      asShown: () => ({ cachedResult: { pan: '***1111', amount: 10 } }),
    });
    expect((await asShown.prepare()).encode('s', 'k', record)).toEqual({
      cachedResult: { pan: '***1111', amount: 10 },
    });
    const noHider = createRecordCodec(Remember.AsShown, { scope: 's' });
    expect((await noHider.prepare()).encode('s', 'k', record)).toEqual({
      [OUTCOME_ONLY_RECORD_KEY]: { v: 1 },
    });
  });
});
