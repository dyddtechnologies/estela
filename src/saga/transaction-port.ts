import type { ErrorClassifier } from './concurrency-errors';

/**
 * Port to the application's database transactions. Estela stays storage-agnostic: the app adapts
 * its own client (TypeORM, Prisma, pg...) and the saga runner decides where a unit of work starts
 * and ends. `Tx` is whatever handle the app's steps use to talk to the database inside it.
 *
 * `run` must open a NEW top-level transaction: joining an ambient one makes a retry unsafe and
 * stretches the unit's locks over the outer transaction.
 *
 * Isolation: a unit's locks are taken after its first statement, so under snapshot isolation
 * (REPEATABLE READ) the steps read a snapshot that predates the lock wait. Steps may rely on a
 * lock for what they read only under READ COMMITTED; under SERIALIZABLE a lost race is a 40001,
 * safe with a retry on 'serialization'. postgresAdvisoryLockPort rejects REPEATABLE READ.
 */
export interface TransactionPort<Tx = unknown> {
  /**
   * Runs `work` in one transaction: commit when it resolves, rollback when it throws. A port may
   * call `work` again after a rollback (its own retry on 40001, for example), each time in a NEW
   * transaction. The runner then resets what the rolled-back call left: the idempotency claim,
   * afterCommit callbacks and in-process locks, and ctx when the saga has a retry policy (without
   * one there is no snapshot, so the re-invoked steps see ctx as the failed call left it). Prefer
   * the saga's `retry()` over a port-level retry: it adds backoff and logs every attempt.
   */
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** Maps a driver error to a concurrency kind; undefined means "not a concurrency failure". */
  classify?: ErrorClassifier;
}
