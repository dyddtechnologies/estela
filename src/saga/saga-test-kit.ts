/**
 * Test doubles shared by the saga specs (not exported from any barrel). FakeDb stages writes per
 * transaction and only makes them visible on commit; failNext injects a driver error into the next
 * transaction, either as its first statement ('body') or at COMMIT ('commit').
 */
import type { IdempotencyLedger, LedgerClaim } from './idempotency-ledger';
import { classifyPostgresError } from './postgres/error-classifier';
import type { TransactionPort } from './transaction-port';

export type FailPhase = 'body' | 'commit';

/** A pg-shaped driver error carrying a SQLSTATE. */
export function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg error ${code}`), { code });
}

export class FakeDb {
  committed: string[] = [];
  transactions = 0;
  rollbacks = 0;
  active = false;
  private readonly failures: { error: unknown; phase: FailPhase }[] = [];

  failNext(error: unknown, phase: FailPhase = 'body'): void {
    this.failures.push({ error, phase });
  }

  /** The port, with classifyPostgresError as its classifier. */
  readonly port: TransactionPort<string[]> = {
    run: <T>(work: (tx: string[]) => Promise<T>) => this.run(work),
    classify: classifyPostgresError,
  };

  /** The same port without a classifier. */
  readonly bare: TransactionPort<string[]> = {
    run: <T>(work: (tx: string[]) => Promise<T>) => this.run(work),
  };

  private async run<T>(work: (tx: string[]) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const staged: string[] = [];
    const failure = this.failures.shift();
    this.active = true;
    try {
      if (failure?.phase === 'body') throw failure.error;
      const result = await work(staged);
      if (failure?.phase === 'commit') throw failure.error;
      this.committed.push(...staged);
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    } finally {
      this.active = false;
    }
  }
}

/** Ledger whose rows live in the same fake transaction as the saga's writes. */
export class TxLedger implements IdempotencyLedger<string[]> {
  claims = 0;

  constructor(private readonly db: FakeDb) {}

  private rows(scope: string, key: string): string[] {
    return this.db.committed.filter((w) => w.startsWith(`ledger:${scope}:${key}:`));
  }

  claim(tx: string[], scope: string, key: string): Promise<LedgerClaim> {
    this.claims += 1;
    const rows = this.rows(scope, key);
    const released = rows.includes(`ledger:${scope}:${key}:released`);
    const done = rows.find((w) => w.includes(':done:'));
    if (rows.length > 0 && !released) {
      return Promise.resolve(
        done === undefined
          ? { status: 'in-progress' }
          : {
              status: 'replay',
              response: JSON.parse(done.split(':done:')[1] ?? 'null') as unknown,
            },
      );
    }
    if (released) {
      this.db.committed = this.db.committed.filter((w) => !w.startsWith(`ledger:${scope}:${key}:`));
    }
    tx.push(`ledger:${scope}:${key}:claimed`);
    return Promise.resolve({ status: 'new' });
  }

  record(tx: string[], scope: string, key: string, response: unknown): Promise<void> {
    tx.push(`ledger:${scope}:${key}:done:${JSON.stringify(response)}`);
    return Promise.resolve();
  }

  release(tx: string[], scope: string, key: string): Promise<void> {
    tx.push(`ledger:${scope}:${key}:released`);
    return Promise.resolve();
  }
}
