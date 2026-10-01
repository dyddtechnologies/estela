/**
 * Port to the application's database transactions. Estela stays storage-agnostic: the app adapts
 * its own client (TypeORM, Prisma, pg...) and the saga runner decides where a unit of work starts
 * and ends. `Tx` is whatever handle the app's steps use to talk to the database inside it.
 */
export interface TransactionPort<Tx = unknown> {
  /** Runs `work` in one transaction: commit when it resolves, rollback when it throws. */
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}
