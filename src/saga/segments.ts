import { SagaUsageError } from './concurrency-errors';
import { canonicalLocks, type LockRequest } from './lock-port';
import type { LockDeclaration, SagaStep, TransactionStep } from './saga';

export interface TransactionSegment<Ctx, Tx> {
  kind: 'transaction';
  steps: { name: string; run: TransactionStep<Ctx, Tx> }[];
  /** Every lock declared by any step of the segment: all are taken once, at its start. */
  locks: LockDeclaration<Ctx>[];
}

export interface OutboundSegment<Ctx, Tx> {
  kind: 'outbound';
  step: Extract<SagaStep<Ctx, Tx>, { kind: 'outbound' }>;
}

export type Segment<Ctx, Tx> = TransactionSegment<Ctx, Tx> | OutboundSegment<Ctx, Tx>;

/** Groups consecutive transaction steps: each group is one unit of work. */
export function segmentsOf<Ctx, Tx>(steps: readonly SagaStep<Ctx, Tx>[]): Segment<Ctx, Tx>[] {
  const segments: Segment<Ctx, Tx>[] = [];
  for (const step of steps) {
    const last = segments[segments.length - 1];
    if (step.kind === 'outbound') {
      segments.push({ kind: 'outbound', step });
      continue;
    }
    const current: TransactionSegment<Ctx, Tx> =
      last?.kind === 'transaction' ? last : { kind: 'transaction', steps: [], locks: [] };
    if (current !== last) segments.push(current);
    current.steps.push({ name: step.name, run: step.run });
    current.locks.push(...(step.locks ?? []));
  }
  return segments;
}

/** True when any transaction step of the definition declares a lock. */
export function declaresLocks<Ctx, Tx>(steps: readonly SagaStep<Ctx, Tx>[]): boolean {
  return steps.some((step) => step.kind === 'transaction' && (step.locks?.length ?? 0) > 0);
}

function asKeyList(raw: string | readonly string[] | undefined): readonly unknown[] {
  if (raw === undefined) return [];
  return typeof raw === 'string' ? [raw] : raw;
}

function keysOf<Ctx>(saga: string, declaration: LockDeclaration<Ctx>, ctx: Ctx): readonly string[] {
  const keys = asKeyList(declaration.keyOf(ctx));
  if (keys.length === 0 && !declaration.optional) {
    throw new SagaUsageError(
      `lock "${declaration.namespace}" in saga "${saga}" resolved no key; mark it optional to skip it`,
    );
  }
  for (const key of keys) {
    if (typeof key !== 'string' || key === '') {
      throw new SagaUsageError(
        `lock "${declaration.namespace}" in saga "${saga}" resolved an empty or non-string key`,
      );
    }
  }
  return keys as readonly string[];
}

/** Default cap on lock requests per unit of work (SagaRunnerOptions.maxLocksPerUnit). */
export const DEFAULT_MAX_LOCKS_PER_UNIT = 64;

/** Resolves the lock keys of a segment from ctx as it is now, then canonicalizes them. More than
 *  `max` requests after dedupe is a SagaUsageError, raised before the transaction starts. */
export function resolveLocks<Ctx>(
  saga: string,
  declarations: readonly LockDeclaration<Ctx>[],
  ctx: Ctx,
  max: number = DEFAULT_MAX_LOCKS_PER_UNIT,
): LockRequest[] {
  if (declarations.length === 0) return [];
  const requests: LockRequest[] = [];
  for (const declaration of declarations) {
    for (const key of keysOf(saga, declaration, ctx)) {
      const base = { namespace: declaration.namespace, key, mode: declaration.mode };
      requests.push(
        declaration.timeoutMs === undefined ? base : { ...base, timeoutMs: declaration.timeoutMs },
      );
    }
  }
  const locks = canonicalLocks(requests);
  if (locks.length > max) {
    throw new SagaUsageError(
      `saga "${saga}" resolved ${locks.length} locks for one unit of work; the limit is ${max} (SagaRunnerOptions.maxLocksPerUnit)`,
    );
  }
  return locks;
}
