import { randomBytes } from 'node:crypto';
import { PrivacyEngine } from '../sensitive/privacy-engine';
import { Remember } from '../sensitive/privacy.types';
import {
  PrivacyConfigError,
  ReplayUnavailableError,
  SealKeyUnavailableError,
} from '../sensitive/privacy-errors';
import { SEALED_RECORD_KEY } from '../sensitive/sealed-record';
import type { SealKey, SealKeyProvider } from '../sensitive/seal-key';
import { captureTrail } from '../testing/capture-trail';
import { expectNoLeak } from '../testing/expect-no-leak';
import { MemoryIdempotencyLedger } from './idempotency-ledger';
import { saga } from './saga';
import { SagaRunner, type SagaRunnerOptions } from './saga-runner';
import type { TransactionPort } from './transaction-port';

const TOKEN = 'CANARYTOKEN0001';

interface Ctx {
  key: string;
  runs: number;
}

/** A transaction port that records whether a transaction is open. */
function transactions(): TransactionPort<null> & { open: boolean } {
  const port = {
    open: false,
    run: async <T>(work: (tx: null) => Promise<T>): Promise<T> => {
      port.open = true;
      try {
        return await work(null);
      } finally {
        port.open = false;
      }
    },
  };
  return port;
}

function sealKeys(port: { open: boolean }): SealKeyProvider & {
  calls: { inTx: boolean }[];
  down: boolean;
} {
  const key: SealKey = { id: 'k1', key: randomBytes(32) };
  const provider = {
    calls: [] as { inTx: boolean }[],
    down: false,
    current: (): Promise<SealKey> => {
      provider.calls.push({ inTx: port.open });
      return provider.down ? Promise.reject(new Error('kms down')) : Promise.resolve(key);
    },
    byId: (id: string): Promise<SealKey | undefined> => {
      provider.calls.push({ inTx: port.open });
      return Promise.resolve(id === key.id ? key : undefined);
    },
  };
  return provider;
}

const pay = saga<Ctx, null, { token: string; ok: boolean }>('pay')
  .idempotent((ctx) => ctx.key)
  .transaction('charge', (ctx) => {
    ctx.runs++;
  })
  .reply(() => ({ token: TOKEN, ok: true }));

function runner(
  privacy: SagaRunnerOptions<null>['privacy'],
  port = transactions(),
): { runner: SagaRunner<null>; ledger: MemoryIdempotencyLedger<null>; port: typeof port } {
  const ledger = new MemoryIdempotencyLedger<null>();
  const options: SagaRunnerOptions<null> = { transactions: port, ledger };
  if (privacy !== undefined) options.privacy = privacy;
  return { runner: new SagaRunner(options), ledger, port };
}

describe('S9 saga ledger (SD-29, SD-33, SD-63, 8.2)', () => {
  it('saga ledger: sealed round trip, seal key fetched outside the transaction', async () => {
    const port = transactions();
    const keys = sealKeys(port);
    const capture = captureTrail();
    const ledger = capture.ledger(new MemoryIdempotencyLedger<null>());
    const sealed = new SagaRunner<null>({
      transactions: port,
      ledger,
      privacy: { remember: Remember.Sealed, sealKeys: keys },
    });
    const ctx = { key: 'k-1', runs: 0 };
    await expect(sealed.run(pay, ctx)).resolves.toEqual({ token: TOKEN, ok: true });
    await expect(sealed.run(pay, ctx)).resolves.toEqual({ token: TOKEN, ok: true });
    expect(ctx.runs).toBe(1);
    expect(capture.writes[0]?.text).toContain(SEALED_RECORD_KEY);
    expect(keys.calls.length).toBeGreaterThan(0);
    expect(keys.calls.every((call) => !call.inTx)).toBe(true);
    expectNoLeak(capture, [TOKEN]);
  });

  it('saga ledger: outcome-only replay', async () => {
    const { runner: outcome } = runner({ rules: { fields: ['**.pan'] } });
    const ctx = { key: 'k-1', runs: 0 };
    await outcome.run(pay, ctx);
    await expect(outcome.run(pay, ctx)).rejects.toBeInstanceOf(ReplayUnavailableError);
    expect(ctx.runs).toBe(1);

    const { runner: answered } = runner({
      remember: Remember.OutcomeOnly,
      replyOnReplay: () => ({ token: 'none', ok: true }),
    });
    const second = { key: 'k-2', runs: 0 };
    await answered.run(pay, second);
    await expect(answered.run(pay, second)).resolves.toEqual({ token: 'none', ok: true });
    expect(second.runs).toBe(1);
  });

  it('saga ledger: AsShown replays the hidden reply; no privacy keeps the reply', async () => {
    const shown = runner({ remember: Remember.AsShown });
    const ctx = { key: 'k-1', runs: 0 };
    await shown.runner.run(pay, ctx);
    await expect(shown.runner.run(pay, ctx)).resolves.toEqual({
      token: '[HIDDEN:secrets.keys]',
      ok: true,
    });

    const plain = runner(undefined);
    await plain.runner.run(pay, { key: 'k-1', runs: 0 });
    await expect(plain.runner.run(pay, { key: 'k-1', runs: 0 })).resolves.toEqual({
      token: TOKEN,
      ok: true,
    });
  });

  it('seal key provider down before the first unit fails closed', async () => {
    const port = transactions();
    const keys = sealKeys(port);
    const { runner: sealed, ledger } = runner({ remember: Remember.Sealed, sealKeys: keys }, port);
    keys.down = true;
    const ctx = { key: 'k-1', runs: 0 };
    await expect(sealed.run(pay, ctx)).rejects.toBeInstanceOf(SealKeyUnavailableError);
    expect(ctx.runs).toBe(0);
    expect(ledger.statusOf('pay', 'k-1')).toBeUndefined();
  });

  it('saga privacy names resolve only with an engine', async () => {
    expect(() => runner({ rules: 'card' })).toThrow(PrivacyConfigError);
    const engine = await PrivacyEngine.compile({
      profiles: { card: { fields: ['**.pan'] } },
    });
    expect(() => runner({ rules: 'card', engine })).not.toThrow();
  });

  it('remember Sealed without seal keys fails when the runner is built', () => {
    expect(() => runner({ remember: Remember.Sealed })).toThrow(PrivacyConfigError);
  });
});
