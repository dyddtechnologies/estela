# Estela 0.9.0: saga concurrency spec

Status: final, ready to implement. Base: `ec13370` (`chore(release): 0.8.0`), branch `feat/saga-concurrency`.

This spec merges two candidate designs:
- **Base: "correctness-first".** It found the latent `RunState` bug, gives a deadlock-freedom argument that holds under hash collisions, treats an unknown CAS outcome as an error, and adds the nested-saga guard.
- **Grafted from "minimal-api":**
  - the `SagaStep` union keeps its two kinds (locks hang off transaction steps);
  - classification is an optional member of `TransactionPort`;
  - claim-before-locks, so a replay takes no locks;
  - retry and afterCommit hops reuse the existing `hopStart`/`hopEnd`;
  - the restore-thunk form of a custom checkpoint.

Every open question from either design is decided here. Section 9 lists the decisions and the reason for each.

## 0. Motivation and scope

The motivating incident is ms-bpm, which runs Estela sagas on Postgres/TypeORM:
- **Global mutex.** "start" took `SELECT ... FOR UPDATE` on a whole flow row, so every user's Start was serialized behind one lock that only needed to be per user.
- **Cache race.** "publish" soft-deleted live instances and invalidated a cache after commit, and readers raced it.
- **Silent CAS loss.** State UPDATEs had no compare-and-set, and a lost update looked like success.
- **Deadlocks as 500s.** Deadlocks and lock timeouts reached the client as 500s instead of being retried.

0.9.0 adds six generic, opt-in primitives. Each is a port, keeping Estela storage-agnostic:
1. locks;
2. unit-of-work retry;
3. afterCommit;
4. state machine with CAS;
5. Postgres adapters that need no `pg` dependency;
6. docs and testing helpers.

**Backward-compatibility contract.** A saga that declares no lock, no retry and no afterCommit behaves byte-for-byte as in 0.8.0:
- same transactions, same hop log lines, same errors;
- `saga.spec.ts` passes unmodified;
- every addition to an existing public type is optional, with one deliberate exception: the third `unit` parameter of `TransactionStep` is required on the call side (see section 2.3, D27). Implementations are unaffected; only code that itself calls a stored step with two arguments stops compiling, and that code would otherwise crash at run time as soon as the step uses `unit`.
- the emitted `.d.ts` stays parseable by TypeScript 4.9 (no `const` type parameters, no `NoInfer`), checked by `test/dist-typescript4.spec.ts`.

## 1. Latent bug fixed as a prerequisite

`claimOnce` sets `state.claimed = true` (or `state.replay`) inside the transaction and never reverts it on rollback. Today a rollback always ends the run, so the flag is harmless.

With retry it becomes a real bug. Attempt 2 would skip the claim because `claimed` is still true, but the claim row was rolled back. The saga would then run unclaimed and `record` an orphan row.

**Fix.** Treat `RunState` as tentative per attempt: copy `{ claimed, replay }` before each attempt and restore the copy when the attempt fails. A regression test covers this (test U5a).

## 2. Public API

All new files sit under `src/saga/` and import nothing from npm. Every comment is English and ASCII-only (`scripts/check-comments-en.cjs`), so comments must not contain arrows or em-dashes.

### 2.1 `concurrency-errors.ts` (new)

```ts
export type ConcurrencyErrorKind = 'lock-timeout' | 'deadlock' | 'serialization' | 'stale-state';
/** Kinds a database classifier may return. 'stale-state' only comes from transition(). */
export type DatabaseErrorKind = Exclude<ConcurrencyErrorKind, 'stale-state'>;
export type ErrorClassifier = (error: unknown) => DatabaseErrorKind | undefined;

export interface ConcurrencyErrorMeta { cause?: unknown; saga?: string; unit?: string; attempts?: number }
export abstract class ConcurrencyError extends Error {
  /** Kind of every instance of a concrete subclass; undefined on the abstract base. */
  static readonly errorKind?: ConcurrencyErrorKind;
  /** Prototype check first, then brand + kind: matches copies from another bundle or realm.
   *  The brand fallback applies only to this base and to classes that declare their OWN static
   *  errorKind; a consumer subclass gets the plain prototype check. */
  static [Symbol.hasInstance](value: unknown): boolean;
  abstract readonly kind: ConcurrencyErrorKind;
  readonly saga?: string; readonly unit?: string; readonly attempts?: number;
  constructor(message: string, meta?: ConcurrencyErrorMeta); // forwards meta.cause to Error's cause
}
export class LockTimeoutError   extends ConcurrencyError { readonly kind = 'lock-timeout' }
export class DeadlockError      extends ConcurrencyError { readonly kind = 'deadlock' }
export class SerializationError extends ConcurrencyError { readonly kind = 'serialization' }
/** Single factory (avoids jscpd clones). The message is built from kind, saga, unit and attempts
 *  ONLY: the driver message (table, constraint, values) stays in `cause`, because apps map these
 *  errors straight to HTTP responses. An unknown kind throws TypeError. */
export function toConcurrencyError(kind: DatabaseErrorKind, cause: unknown, meta: Omit<ConcurrencyErrorMeta, 'cause'>): ConcurrencyError;
/** Runtime guard for classifier results: true only for 'lock-timeout' | 'deadlock' | 'serialization'. */
export function isDatabaseErrorKind(kind: unknown): kind is DatabaseErrorKind;

export class SagaDefinitionError extends Error {} // build-time misuse (thrown by the builder)
export class SagaUsageError extends Error {}      // run-time misuse (missing port, nested saga, late afterCommit, uncloneable ctx)
```

`StaleStateError` also extends `ConcurrencyError` (kind `'stale-state'`). It is defined in `transition.ts`.

**Class identity across bundles.** The CJS build bundles each entry point (`.` and `./testing`) on its own, so `MemoryLockPort` carries its own copy of `LockTimeoutError`. Every instance carries a non-enumerable `Symbol.for('@estela/nest.ConcurrencyError')` brand, and `ConcurrencyError[Symbol.hasInstance]` falls back to brand + `kind` (`errorKind`) after the normal prototype check. So `instanceof` holds across copies, and the runner's `classify` retries a foreign `LockTimeoutError`. The fallback is limited to `ConcurrencyError` itself and to a class with an own static `errorKind` (`Object.hasOwn(this, 'errorKind')`): a consumer subclass such as `class FlowStartLockTimeout extends LockTimeoutError {}` inherits `errorKind`, and without that limit every `LockTimeoutError` would pass `instanceof FlowStartLockTimeout`. Code splitting for CJS was rejected: tsup's CJS splitting path renames classes (`_class2`), which breaks `error.name` and every `constructor.name` log. `test/dist-identity.spec.ts` checks both built formats with plain `node`.

### 2.2 `transaction-port.ts` (one optional member)

```ts
export interface TransactionPort<Tx = unknown> {
  /** May call `work` more than once (each time in a NEW transaction), e.g. its own retry on 40001. */
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** Maps a driver error to a concurrency kind; undefined means "not a concurrency failure". */
  classify?: ErrorClassifier;
}
```

**Re-invoked `work`.** The contract does not forbid a port from calling `work` again inside one `run()` (a common wrapper retries on 40001). The runner treats every call after the first as a fresh transaction: before it, it restores `{ claimed, replay }` to their value at the start of the attempt (so the ledger claim is redone in the new transaction), empties the afterCommit list (callbacks of the rolled-back call never run), runs and empties the in-process lock releases (so `MemoryLockPort` does not wait on itself), and, when the saga has a retry policy, restores ctx from the attempt's checkpoint. Without a retry policy there is no snapshot, so the re-invoked steps see ctx as the failed call left it (documented on `TransactionPort.run`). A port-level retry is still discouraged: `retry()` adds backoff and a hop line per attempt.

**Decision.** Classification belongs on `TransactionPort`, because the database that runs the transaction is the one that knows its own error codes. `SagaRunnerOptions.classifyError` overrides it per runner (section 2.5). Classifying from `LockPort` was considered and dropped: deadlocks and serialization failures come from step code, not from lock acquisition.

### 2.3 `saga.ts` (extended)

```ts
export interface UnitOfWork {
  /** 1-based attempt number of this unit of work (> 1 only under a retry policy). */
  readonly attempt: number;
  /** Runs fn after THIS unit of work commits, in registration order. Discarded if the attempt
   *  rolls back. Throws SagaUsageError when called after the attempt settled. */
  afterCommit(fn: () => Promise<void> | void): void;
}
/** Stored and call-side type. The runner ALWAYS passes `unit`, and the type requires it. A
 *  2-argument implementation is still assignable. */
export type TransactionStep<Ctx, Tx> = (ctx: Ctx, tx: Tx, unit: UnitOfWork) => Promise<void> | void;
export type OutboundStep<Ctx> = (ctx: Ctx) => Promise<void> | void;   // unchanged

export type LockMode = 'shared' | 'exclusive';
export type LockKeyOf<Ctx> = (ctx: Ctx) => string | readonly string[] | undefined;
export interface LockOptions {
  /** Integer ms, 1..2147483647. Undefined: the LockPort default (Postgres: session lock_timeout). */
  timeoutMs?: number;
  /** false (default): keyOf returning undefined or [] is a SagaUsageError. true: no lock taken. */
  optional?: boolean;
}
export interface LockDeclaration<Ctx> {
  readonly namespace: string;  // non-empty, <= 200 chars
  readonly keyOf: LockKeyOf<Ctx>;
  readonly mode: LockMode;
  readonly timeoutMs?: number;
  readonly optional: boolean;
}

export interface OutboundOptions<Ctx, Tx> {
  compensate?: TransactionStep<Ctx, Tx>;   // a wrapper calling it must forward `unit`
  /** 'inherit' (default): the compensation re-acquires the exact LockRequests resolved for the
   *  transaction segment right before this outbound step. 'none': no locks. */
  compensateLocks?: 'inherit' | 'none';
}

export type JitterMode = 'full' | 'equal' | 'none';
export interface RetryPolicy<Ctx> {
  on: readonly ConcurrencyErrorKind[];   // non-empty, no duplicates
  attempts: number;                      // TOTAL attempts incl. the first; integer 1..20
  backoffMs: number;                     // integer >= 0; base of the exponential backoff
  maxBackoffMs?: number;                 // integer >= backoffMs; default backoffMs * 32
  jitter?: JitterMode;                   // default 'full'
  /** 'clone' (default) or a function that snapshots ctx and returns a restore thunk.
   *  The thunk MUST mutate ctx in place: ctx identity is kept across attempts. */
  checkpoint?: 'clone' | ((ctx: Ctx) => () => void);
}

export type SagaStep<Ctx, Tx> =
  | { kind: 'transaction'; name: string; run: TransactionStep<Ctx, Tx>;
      locks?: readonly LockDeclaration<Ctx>[] }                       // new optional field
  | { kind: 'outbound'; name: string; run: OutboundStep<Ctx>;
      compensate?: TransactionStep<Ctx, Tx>; compensateLocks?: 'inherit' | 'none' };

export interface SagaDefinition<Ctx, Tx, Reply> {
  readonly name: string;
  readonly steps: readonly SagaStep<Ctx, Tx>[];
  readonly idempotencyKey?: (ctx: Ctx) => string | undefined;
  readonly retry?: Readonly<RetryPolicy<Ctx>>;
  readonly reply: (ctx: Ctx) => Reply;
}

export class SagaBuilder<Ctx, Tx, Reply> {
  idempotent(keyOf): this;
  transaction(name, run: TransactionStep<Ctx, Tx>): this;
  outbound(name, run, options?: OutboundOptions<Ctx, Tx>): this;
  /** namespace doubles as the step name in logs. Mode is REQUIRED (no implicit exclusive). */
  lock(namespace: string, keyOf: LockKeyOf<Ctx>, mode: LockMode, options?: LockOptions): this;
  retry(policy: RetryPolicy<Ctx>): this;  // validated eagerly; a second call throws SagaDefinitionError
  reply(reply): SagaDefinition<Ctx, Tx, Reply>;
}
```

**Backward compatibility.** A 2-argument step is still assignable, because TS allows a parameter list to be shorter, so every 0.8 step implementation compiles unchanged. A value typed `TransactionStep`, `definition.steps[i].run` and `OutboundOptions.compensate` now require `unit` at the call site. An earlier draft kept `unit` optional there so that 0.8 call sites `step(ctx, tx)` kept compiling, but that typing was unsound: TS also lets a function with a required third parameter be assigned to one with an optional one, so a generic wrapper `(s: TransactionStep) => (ctx, tx) => s(ctx, tx)` type-checked around a step that calls `unit.afterCommit`, and the step then failed on every run with `Cannot read properties of undefined`. A compile error (TS2554) at the call site is the honest outcome. Tests that call a step directly use `testUnitOfWork()` from `@estela/nest/testing`. Compensations also receive `unit` as their third argument.

**Why the union keeps two kinds.** `SagaStep` keeps exactly two kinds, so a consumer's exhaustive `switch (step.kind)` still compiles. Locks hang off transaction steps through the optional `locks` field.

**Lock placement rule (enforced in the builder, error `SagaDefinitionError`).**
- `.lock()` appends to a pending list. The next `.transaction()` takes the pending list into its `locks`. This is forward binding, so pending locks are never attached backwards.
- `.outbound()` or `.reply()` while pending locks exist is an error: `lock "<ns>" in saga "<s>" is not followed by a transaction step in the same unit of work`.
- So `.lock().outbound()`, `.transaction(a).lock(x).outbound()` and a trailing `.lock()` are all errors. `.outbound(o).lock(x).transaction(b)` is legal, and `x` belongs to `b`'s segment.
- Any lock written between two transaction steps of the same segment belongs to that segment. All locks of a segment are acquired once, at its start.
- **Decision (forward-only binding).** "Attach to the previous transaction" was rejected. Reading top-down, a lock written after a step would look as if it protected only the steps after it, yet it would be taken before that step ran.

**Consequence: segment-start keys.** Lock keys are computed from `ctx` as it is when the segment starts. A key that depends on a value read inside the same segment must be computed in an earlier segment, or by the caller.

### 2.4 `lock-port.ts` (new)

```ts
export interface LockRequest {
  readonly namespace: string; readonly key: string;
  readonly mode: LockMode; readonly timeoutMs?: number;
}
export interface LockScope {
  /** In-process ports register their release here; the runner calls it after transactions.run
   *  settles (commit or rollback). Database ports ignore it: their locks are tx-scoped. */
  onRelease(fn: () => void): void;
}
export interface LockPort<Tx = unknown> {
  /** Acquires every request, transaction-scoped (never session-scoped), in the order given.
   *  Requests arrive deduplicated and sorted by canonicalLocks(). A port whose physical lock
   *  identity differs from (namespace, key), e.g. hashing, MUST re-sort by physical identity and
   *  merge physical collisions with the same rules. */
  acquire(tx: Tx, locks: readonly LockRequest[], scope: LockScope): Promise<void>;
}
/** Pure: dedupe by (namespace, key), exclusive wins, smallest timeoutMs wins; then sort by
 *  namespace, then key, in UTF-16 code-unit order (a < b), NEVER localeCompare. */
export function canonicalLocks(requests: readonly LockRequest[]): LockRequest[];
```

- **Why `LockScope`.** It lets in-process ports work without wrapping `TransactionPort`. This replaces the "minimal-api" `transactions()` wrapper.
- **No release method.** `LockPort` has none on purpose: database ports release on commit or rollback.

### 2.5 `saga-runner.ts` options

```ts
export interface SagaRunnerOptions<Tx> {
  transactions: TransactionPort<Tx>;
  ledger?: IdempotencyLedger<Tx>;
  logger?: HopLogger;
  /** Required when a definition declares locks (SagaUsageError at run(), before any tx). */
  locks?: LockPort<Tx>;
  /** Overrides transactions.classify. Order: Estela typed errors, then this, then transactions.classify. */
  classifyError?: ErrorClassifier;
  /** Called when an afterCommit callback throws; its own throw is caught and logged. */
  onAfterCommitError?: (error: unknown, info: AfterCommitErrorInfo) => void;
  /** Most lock requests one unit may resolve (after dedupe); positive integer, default 64. */
  maxLocksPerUnit?: number;
  /** Test seams; defaults: node:timers/promises setTimeout and node:crypto randomInt. */
  sleep?: (ms: number) => Promise<void>;
  random?: (maxExclusive: number) => number;
}
export interface AfterCommitErrorInfo { saga: string; unit: string; index: number; correlationId: string }
```

**Fail-fast checks in `run()`.** All run before any transaction starts:
- `definition.retry` and every lock declaration are re-validated with the builder's rules (`SagaDefinitionError`). `SagaDefinition` is a public plain interface, so a hand-built or spread definition must not bypass `attempts` 1..20, the kind list or the integer backoff (an `attempts: Infinity` policy would otherwise hot-loop against the database). The runner uses the validated, frozen copy.
- the definition declares any lock and `options.locks` is undefined: `SagaUsageError`;
- `definition.retry.on` contains a database kind (`lock-timeout`, `deadlock` or `serialization`), and neither `classifyError` nor `transactions.classify` is set: `SagaUsageError`. Without a classifier the retry would silently never fire. A policy whose `on` is only `['stale-state']` needs no classifier.
- the definition has a retry policy and an idempotency key, and `options.ledger.transactional === false`: `SagaUsageError`. Section 1's fix assumes the claim rolls back with the attempt; a ledger that ignores `tx` (`MemoryIdempotencyLedger`) keeps it, so attempt 2 would see `in-progress`, or a `replay` of a reply whose writes never committed (a commit-time failure after `record`).

**`IdempotencyLedger.transactional?: boolean`** (additive, optional). `false` declares that claim/record/release ignore `tx`; undefined counts as `true`. `MemoryIdempotencyLedger` sets `false`.

### 2.6 `trace/hop-logger.ts` (one additive method)

```ts
/** Always logged at error level, regardless of the configured hop level. */
hopError(channel: string, target: string, h: MessageHeaders, error: unknown): void;
```

**Retry and lock hops.** These reuse `hopStart`/`hopEnd` through the runner's `traced()`:
- `locks:<n>` brackets lock acquisition;
- `retry:<kind>#<nextAttempt>` brackets the backoff sleep;
- `after-commit:<unit>#<i>` brackets each callback.

**afterCommit failures.** A failing callback is reported through `hopError`. If no logger is configured, the runner falls back to a static `new Logger('EstelaSaga').error(...)`, so an afterCommit failure is never silent.

### 2.7 `state-machine.ts` (new)

```ts
type Targets<M> = { readonly [K in keyof M]: readonly (keyof M & string)[] };
export type StateOf<M> = keyof M & string;
export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  isState(value: unknown): value is S;
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S): void;    // IllegalTransitionError
  sourcesOf(to: S): readonly S[];            // precomputed inverse map, frozen
  targetsOf(from: S): readonly S[];
  isTerminal(state: S): boolean;
}
// No `const` modifier: it is TS 5.0+ syntax and would make the shared .d.ts chunk unparseable on
// TS 4.x for every consumer. Literal targets are inferred through the Targets<M> constraint alone.
export function defineStateMachine<M extends Targets<M>>(name: string, map: M): StateMachine<StateOf<M>>;
export class IllegalTransitionError extends Error {   // logic error, never retried
  constructor(readonly machine: string, readonly from: readonly string[], readonly to: string);
}
```

- **Compile-time checks.** Every state must appear as a key, so a terminal state is written as `X: []`. A target that is not a key is a compile error.
- **Run-time checks.** The map must be non-empty. Targets must also be keys, which catches `as any` maps. Duplicate targets are rejected. The result is frozen.
- **Self-transitions** are legal only when listed explicitly.

### 2.8 `transition.ts` (new)

```ts
export interface CasCommand {
  machine: string; id: string | number;
  from: readonly string[]; to: string; expectedVersion?: number;
}
export interface CasResult { /** MUST be an integer. */ affected: number; /** new version when tracked */ version?: number }
export interface TransitionPort<Tx = unknown> { compareAndSet(tx: Tx, command: CasCommand): Promise<CasResult> }

export interface TransitionRequest<S extends string> {
  id: string | number; to: S;
  from?: S | readonly S[];          // default: machine.sourcesOf(to)
  expectedVersion?: number;         // safe integer
}
export interface TransitionOutcome<S extends string> { id: string | number; from: readonly S[]; to: S; version?: number }
export function transition<S extends string, Tx>(
  machine: StateMachine<S>, port: TransitionPort<Tx>, tx: Tx, request: TransitionRequest<StateOnly<S>>,
): Promise<TransitionOutcome<S>>;
/** Blocks inference from the request (same as TS 5.4 NoInfer, kept out of the .d.ts for older TS). */
type StateOnly<S> = [S][S extends unknown ? 0 : never];

export class StaleStateError extends ConcurrencyError {
  readonly kind = 'stale-state';
  readonly machine: string; readonly id: string | number;
  readonly from: readonly string[]; readonly to: string; readonly expectedVersion?: number;
}
export class TransitionOutcomeUnknownError extends Error { readonly received: unknown }
```

**S comes from the machine only.** `StateMachine<S>` has bivariant method signatures and a covariant `states` array, so inferring S from both the machine and the request let a misspelled `to` or `from` widen S and compile; it then failed at run time with `IllegalTransitionError` on every call. `StateOnly` makes it a compile error (type test in `state-machine.spec.ts`).

**Checks before the port is called.** Each of these throws, and the port is never called:
- `from` omitted and `sourcesOf(to)` is empty: `IllegalTransitionError`;
- any given `from` that cannot transition to `to`: `IllegalTransitionError`;
- `expectedVersion` that is not a safe integer: `TypeError`.

**Reading `affected`:**

| `affected` | Outcome |
|---|---|
| `1` | returns the outcome |
| `0` | `StaleStateError`: row missing, or its state or version changed |
| `undefined`, `null`, `NaN`, non-integer, string, negative, or `> 1` | `TransitionOutcomeUnknownError` |

- **Unknown outcome.** It is never success and never stale. `> 1` means the id is not unique, and is reported the same way.
- **Rollback.** Every throw happens inside the step, so the unit of work rolls back and nothing is half-applied.
- **Error message.** It says that the port must return an exact integer row count. A count-less driver result has to be adapted in the app's query function.

### 2.9 `postgres/` (new; no npm imports, exported from the main barrel)

```ts
// postgres/sql.ts
export type SqlQuery = (sql: string, params: readonly unknown[]) => Promise<unknown>;
export type SqlQueryOf<Tx> = (tx: Tx) => SqlQuery;
/** Accepts a row array (TypeORM query(), Prisma $queryRawUnsafe) or { rows } (pg).
 *  Anything else: UnexpectedQueryResultError. Never reads rowCount. */
export function rowsOf(raw: unknown): readonly Record<string, unknown>[];
export class UnexpectedQueryResultError extends Error {}
/** /^[A-Za-z_][A-Za-z0-9_]{0,62}$/ then "name"; anything else throws TypeError. */
export function quoteIdentifier(name: string): string;

// postgres/error-classifier.ts
export function classifyPostgresError(error: unknown): DatabaseErrorKind | undefined;

// postgres/advisory-lock-port.ts
export interface PostgresLockPortOptions<Tx> {
  query: SqlQueryOf<Tx>; defaultTimeoutMs?: number;
  /** Default false: a REPEATABLE READ transaction throws SagaUsageError (see "Isolation"). */
  allowSnapshotIsolation?: boolean;
}
export function postgresAdvisoryLockPort<Tx>(options: PostgresLockPortOptions<Tx>): LockPort<Tx>;
/** The int8 lock key of ($1 namespace, $2 key) as SQL, for code outside Estela that takes the same lock. */
export const ADVISORY_LOCK_KEY_SQL: string;

// postgres/transition-port.ts
export interface PostgresTransitionPortOptions<Tx> {
  query: SqlQueryOf<Tx>;
  table: string; schema?: string;
  idColumn?: string;      // default 'id'
  stateColumn?: string;   // default 'state'
  idType?: string;        // 'name' or 'schema.name'; casts $2::text::<type> (typed-parameter drivers)
  stateType?: string;     // same, for the state value $1
  versionColumn?: string; // off by default
  touchColumn?: string;   // set to now() on success; off by default
}
export function postgresTransitionPort<Tx>(options: PostgresTransitionPortOptions<Tx>): TransitionPort<Tx>;
```

#### `classifyPostgresError`

- **Where it looks.** It reads a string `code` on the error, then `error.driverError` (TypeORM `QueryFailedError`), then `error.meta.code` (Prisma raw query errors), then walks `error.cause` up to 5 levels deep.
- **What it maps.** Only exact SQLSTATE matches count:

  | SQLSTATE | Kind |
  |---|---|
  | `55P03` | `lock-timeout` |
  | `40P01` | `deadlock` |
  | `40001` | `serialization` |

- **Prisma ORM errors.** `P2034` ("Transaction failed due to a write conflict or a deadlock") carries no SQLSTATE. It is read from the top-level `code` only and mapped to `deadlock`, the only cause under the default READ COMMITTED; under REPEATABLE READ or SERIALIZABLE it may be a serialization failure, so the docs tell Prisma users to list both kinds.
- **What it never classifies:**
  - `57014` (statement_timeout): may be a slow query, not contention;
  - `08xxx` and `57P01` (connection lost, admin shutdown): the commit outcome is unknown, so a retry could re-apply work that actually committed.

#### Advisory lock SQL

Every value is bound as a parameter. Only transaction-scoped `_xact_` functions are used.

1. Compute physical identities, and read the isolation level, in one round trip:
   ```sql
   SELECT l.i::int AS i,
          ('x' || left(encode(sha256(convert_to(length(l.n) || ':' || l.n || l.k, 'UTF8')), 'hex'), 16))::bit(64)::int8::text AS h,
          current_setting('transaction_isolation') AS iso
   FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS l(n, k, i)
   ```
   The identity is one int8: the first 64 bits of SHA-256 over `length(n) || ':' || n || k`. The length prefix makes the encoding injective (no `("a:b", "c")` / `("a", "b:c")` aliasing), and SHA-256 makes a targeted collision cost about 2^64 work. The earlier `(hashtext(n), hashtext(k))` identity let anyone who controls part of a key (a username) brute-force a 32-bit `hashtext` collision with another user's key offline, then hold that user's lock (targeted denial of service). The key is returned as text so pg, TypeORM and Prisma all read it the same way; the client parses it as a decimal int8 and rejects anything else (`UnexpectedQueryResultError`). Needs Postgres 11+ (`sha256`). `ADVISORY_LOCK_KEY_SQL` exports the same expression over `$1::text`, `$2::text`.

   `iso = 'repeatable read'` throws `SagaUsageError` before any lock unless `allowSnapshotIsolation: true`.
2. In the client, sort by the signed int8 key. Merge physical collisions (kept for correctness, though no longer expected): exclusive wins, the smallest timeout wins. This sort is what makes the order canonical; `canonicalLocks` only gives a deterministic input.
3. If any request has an effective timeout, read the current value once with `SELECT current_setting('lock_timeout') AS prev`.
4. For each lock:
   - if its timeout differs from the one currently set, run `SELECT set_config('lock_timeout', $1, true)` with `$1 = \`${ms}ms\``. `ms` must pass `Number.isSafeInteger(ms) && ms >= 1 && ms <= 2147483647`, otherwise `TypeError` before any query;
   - then run `SELECT 1 AS ok FROM pg_advisory_xact_lock($1::int8)` with the key as a decimal string, or the `_shared` variant.

   The lock function sits in FROM, so no `void` column is ever returned. Prisma's raw deserializer rejects `void` columns.
5. If step 3 ran, restore with `SELECT set_config('lock_timeout', $1, true)` and `$1 = prev`. The lock timeout therefore never leaks into the step's own row locks.

#### Isolation

A unit's first statement (the ledger claim, or the hash query above) takes the transaction snapshot under REPEATABLE READ, and it runs BEFORE the lock wait. After the lock is granted the steps still read that pre-wait snapshot: the lock serializes execution but not visibility. A read-then-insert invariant ("one Start per user") then inserts twice, silently: REPEATABLE READ raises no 40001 for inserts (P14 control). Hence:
- READ COMMITTED (a snapshot per statement): the lock protects reads. Recommended.
- SERIALIZABLE: the same race raises 40001; safe with `retry({ on: ['serialization'] })` (P14).
- REPEATABLE READ: rejected by `postgresAdvisoryLockPort`; `allowSnapshotIsolation: true` is for steps that never read what the lock guards.

Notes:
- `set_config(..., true)` is the parameterized form of `SET LOCAL`. `SET LOCAL` itself cannot take bind parameters.
- The single-int8 form shares its key space (`objsubid = 1`: `classid` holds the high 32 bits, `objid` the low 32) with apps that call `pg_advisory_xact_lock(bigint)` themselves. A clash with such an app's own keys is as unlikely as a 64-bit hash collision, and only over-serializes.

#### CAS SQL

The statement is built once at construction. Identifiers are validated, then quoted; all values are bound.

```sql
WITH changed AS (
  UPDATE "schema"."table"
     SET "state" = $1[::text::"stateType"] [, "version" = "version" + 1] [, "touch" = now()]
   WHERE "id" = $2[::text::"idType"] AND "state"::text = ANY($3::text[]) [AND "version" = $4]
  RETURNING [ "version" | 1 AS one ])
SELECT count(*)::int AS affected [, max("version") AS version] FROM changed
```

- **SELECT-shaped on purpose.** pg returns `{ rows }`, and TypeORM `query()` returns a row array. That sidesteps TypeORM's `[rows, rowCount]` UPDATE shape, which is the root cause of the `if (!updateResult)` incident.
- **Enum-typed state columns.** The guard compares `"state"::text`, so it works for any column type. Assigning `$1` and comparing `$2` rely on Postgres typing the parameter from the column, which holds only for drivers that bind untyped parameters (pg, TypeORM).
- **Typed-parameter drivers (Prisma).** `$queryRawUnsafe` binds a JS string as `text`, so a uuid id gives 42883 (`uuid = text`) and an enum state gives 42804. `idType` / `stateType` (`name` or `schema.name`, each part validated with the identifier regex and quoted, so catalog names such as `uuid`, `int8`, `app.status_enum`) emit `$n::text::"type"`. They are opt-in: without them the statement is unchanged.
- **Count check.** `affected` is checked with `Number.isInteger`; anything else throws `TransitionOutcomeUnknownError`.
- **Version guard.** `expectedVersion` without `versionColumn` throws `TypeError` before any query.
- **Reading the version.** With `versionColumn`, the new version may arrive as a number (int4), a numeric string (int8 through pg) or a `bigint` (int8 through Prisma). Anything that is not a safe integer throws `UnexpectedQueryResultError` (the unit rolls back) instead of being dropped: a dropped version turns the caller's next `expectedVersion` guard off silently.

#### Wiring examples (for README and skills)

- **TypeORM:** `query: (m: EntityManager) => (s, p) => m.query(s, [...p])`
- **pg:** `query: (c: PoolClient) => (s, p) => c.query(s, [...p])`
- **Prisma:** `query: (tx) => (s, p) => tx.$queryRawUnsafe(s, ...p)`
- **TransactionPort classify:** `{ run, classify: classifyPostgresError }`

### 2.10 Testing subpath (`src/testing/`, `@estela/nest/testing`)

```ts
/** In-process only, NOT cross-process, no deadlock detection. FIFO readers-writer lock per
 *  (namespace, key) (no writer starvation); timeoutMs throws LockTimeoutError; releases via LockScope. */
export class MemoryLockPort<Tx = unknown> implements LockPort<Tx> {
  constructor(options?: { defaultTimeoutMs?: number });
  held(namespace: string, key: string): LockMode[];
  readonly acquisitions: readonly (readonly LockRequest[])[];
}
/** A UnitOfWork for calling a transaction step directly: commit() runs the callbacks in order,
 *  rollback() discards them; afterCommit after either throws a plain Error (not SagaUsageError:
 *  the CJS testing bundle has its own copy of that class). */
export function testUnitOfWork(attempt?: number): TestUnitOfWork;
/** Atomic CAS on a Map (single-threaded); failure injection via forceNext. */
export class MemoryTransitionPort<Tx = unknown> implements TransitionPort<Tx> {
  seed(id: string | number, state: string, version?: number): void;
  get(id: string | number): { state: string; version: number } | undefined;
  forceNext(result: CasResult | Error | unknown): void;
}
```

### 2.11 Barrel (`src/index.ts`)

**Exported:** `export *` from:
- `saga/concurrency-errors`, `saga/lock-port`, `saga/state-machine`, `saga/transition`;
- `saga/postgres/index` (it has zero npm imports, so it is safe in the barrel).

**Kept internal:** `unit-of-work`, `segments`, `retry-policy` and `saga-definition`.

**Header comment.** The barrel header is currently Spanish. Translate it to English while touching the file, as AGENTS.md and the comment check require.

## 3. File layout

```
src/saga/saga.ts                  builder, SagaStep, UnitOfWork type, lock()/retry(), placement check
src/saga/saga-definition.ts       validateRetryPolicy, validateLockDeclaration (keeps saga.ts under complexity caps)
src/saga/segments.ts              segmentsOf() moved out of the runner; segments carry locks
src/saga/saga-runner.ts           orchestration only; every tx goes through unit-of-work.ts
src/saga/unit-of-work.ts          attempt loop: checkpoint, RunState copy, locks, ALS marker, afterCommit, classify, backoff
src/saga/retry-policy.ts          delayFor, defaultCheckpoint (assertPlainGraph + structuredClone)
src/saga/lock-port.ts             LockPort, LockRequest, LockScope, canonicalLocks
src/saga/concurrency-errors.ts
src/saga/state-machine.ts
src/saga/transition.ts
src/saga/postgres/{sql,error-classifier,advisory-lock-port,transition-port,index}.ts
src/saga/**/*.spec.ts
src/testing/memory-lock-port.ts, memory-transition-port.ts, test-unit-of-work.ts (+ testing/index.ts exports)
test/saga-postgres.e2e.spec.ts    skipped unless ESTELA_PG_URL
test/dist-typescript4.spec.ts     no TS 5-only syntax in dist/*.d.ts (skipped until built)
docs/SAGA_CONCURRENCY_SPEC.md     this file
```

**Repo rules this layout must satisfy:**
- **Complexity.** eslint caps `complexity` at 12 and sonarjs cognitive complexity at 15, which is why the retry loop lives in `unit-of-work.ts`, not in the runner.
- **New depcruise rule `saga-postgres-no-npm`.** Nothing under `^src/saga/postgres/` may depend on an npm package, and no `^src/` file may import `pg`.
- **Runtime dependencies.** None are added. `node:crypto`, `node:timers/promises` and `node:async_hooks` are core modules; Node >= 18 also provides `structuredClone`.
- **devDependencies.** `pg` and `@types/pg` are added for `test/` only. After `npm i -D`, re-run `npm audit` and lockfile-lint (both are part of `npm run verify`).
- **SQL constants.** The SQL strings are module-level constants built once, which avoids sonarjs `sql-queries` hotspots. A lint suppression is allowed only with a one-line WHY comment.

## 4. Runner algorithm

```text
run(def, ctx, opts):
  retry = def.retry && validateRetryPolicy(def.retry); validate every lock declaration
  if uowScope.getStore() is set AND (store.holdsLocks OR store.retries OR def declares locks or retry):
      throw SagaUsageError('saga started inside a unit of work that holds locks or uses retry')
  if def declares locks AND !options.locks: throw SagaUsageError
  if retry?.on has a database kind AND no classifier: throw SagaUsageError
  if retry AND def.idempotencyKey AND ledger.transactional === false: throw SagaUsageError
  ...unchanged flowStart/flowEnd... walk()

walk(def, ctx, headers):                     // same shape as today
  segments = segmentsOf(def.steps); state = { key?, claimed: false }; lastLocks = []
  for [index, segment]:
    if outbound: await runOutbound(def, segment.step, ctx, state, headers, lastLocks); continue
    locks = resolveLocks(def.name, segment.locks, ctx, maxLocksPerUnit)   // once per unit, before attempt 1; canonicalLocks(); > max: SagaUsageError
    lastLocks = locks
    reply = await uow.execute({ def, ctx, state, headers, label: `tx#${index}`, locks },
      async (tx, unit, acquire) => {
        if (!(await claimOnce(def.name, tx, state))) return undefined   // claim FIRST: a replay takes no locks
        await acquire()                                                // then all locks, one call
        for step of segment.steps: await traced(`transaction:${step.name}`, () => step.run(ctx, tx, unit))
        if (!isLast) return undefined
        value = def.reply(ctx); await recordIfClaimed(...); return { value }
      })
    if (state.replay) return state.replay.response
  if (reply) return reply.value
  return finishAfterOutbound(...)              // record tx goes through uow.execute with no locks

runOutbound(..., lastLocks):
  claim-only tx       -> uow.execute({ locks: [] }, claimOnce body)          // retried by the policy
  try traced(outbound, step.run(ctx))                                        // NEVER retried
  catch -> compensate(..., step.compensateLocks === 'none' ? [] : lastLocks); rethrow outbound error
compensate: uow.execute({ locks }, (tx, unit, acquire) => { await acquire(); await compensate?.(ctx, tx, unit); ledger.release(...) })

unit-of-work.execute(plan, body):
  policy = validated retry
  restore = policy ? checkpoint(plan, policy) : undefined   // before attempt 1
  for attempt = 1..:
    outcome = await runAttempt(plan, body, attempt, restore)
    if outcome.ok: await drainAfterCommit(outcome.callbacks, plan); return outcome.value   // outside any catch
    kind = classify(outcome.error)
    if policy && restore && kind && policy.on.includes(kind) && attempt < policy.attempts:
       restore(); await traced(`retry:${kind}#${attempt + 1}`, () => sleep(delayFor(policy, attempt, random))); continue
    throw kind === undefined ? outcome.error
        : outcome.error instanceof ConcurrencyError ? outcome.error
        : toConcurrencyError(kind, outcome.error, { saga, unit: plan.label, attempts: attempt })

checkpoint(plan, policy):
  try checkpointOf(policy, ctx)
  catch: if plan.strictCheckpoint (tx#0 or the first claim: nothing committed, no outbound ran) rethrow
         else hopError(`checkpoint:<label>`) and return undefined   // the unit runs once, no retry
  // A compensation, the ledger record or a unit after an outbound must never be blocked by a ctx
  // that became uncloneable: committed work would stay un-compensated, the key stuck claimed, and
  // the outbound error replaced by SagaUsageError.

runAttempt(plan, body, n, restore):
  saved = { claimed: state.claimed, replay: state.replay }; callbacks = []; releases = []; open = true
  unit = { attempt: n, afterCommit: fn => { if (!open) throw SagaUsageError; callbacks.push(fn) } }
  acquire = () => plan.locks.length === 0 ? undefined
             : traced(`locks:${plan.locks.length}`, () => lockPort.acquire(tx, plan.locks, { onRelease: f => releases.push(f) }))
  work = tx => {
    if this is not the first call of work in this run():     // the port re-invoked it (section 2.2)
      state.claimed = saved.claimed; state.replay = saved.replay
      callbacks = []; run and empty releases; restore?.()
    return body(tx, unit, acquire)
  }
  try:
    value = await uowScope.run({ holdsLocks: plan.locks.length > 0, retries: plan.retry !== undefined }, () =>
              transactions.run(work))
    return { ok: true, value, callbacks }
  catch (error):
    state.claimed = saved.claimed; state.replay = saved.replay      // section 1 fix
    return { ok: false, error }                                     // callbacks dropped
  finally:
    open = false; for r of releases reversed: try r() catch log

classify(e):
  e instanceof ConcurrencyError                          -> e.kind
  IdempotencyInProgressError | IllegalTransitionError |
  TransitionOutcomeUnknownError | SagaUsageError         -> undefined (never retried)
  else k = options.classifyError?.(e) ?? transactions.classify?.(e)
       isDatabaseErrorKind(k) ? k : undefined
  // A classifier is user code: a typo ('lock_timeout'), 'stale-state' or any other value means
  // "unclassified", so the original error is rethrown instead of a TypeError from the factory.

drainAfterCommit: sequential, each awaited inside traced(`after-commit:${label}#${i}`);
  on throw: hopError (or the static Logger fallback), then onAfterCommitError in its own try/catch; continue.
  Never throws. Runs before the next segment, the next outbound and before run() resolves.

delayFor(p, n, random): cap = min(p.maxBackoffMs ?? p.backoffMs * 32, 2147483647)   // setTimeout limit
  d = min(cap, p.backoffMs * 2 ** (n - 1))
  full: random(d + 1); equal: floor(d / 2) + random(ceil(d / 2) + 1); none: d

checkpointOf(policy, ctx):
  function form: return policy.checkpoint(ctx)
  'clone' (default): assertPlainGraph(ctx) then snap = structuredClone(ctx); return () => {
      fresh = structuredClone(snap); delete own keys of ctx absent from fresh; Object.assign(ctx, fresh) }
    assertPlainGraph: the root may be any object (it keeps its identity and prototype); nested values must be
    primitives, plain objects, arrays, Date, Map, Set, RegExp or ArrayBuffer views. Anything else (class
    instances, functions, entities) is rejected with SagaUsageError: "ctx is not cloneable at <path>;
    provide retry.checkpoint". This avoids structuredClone silently stripping prototypes.
    It also rejects symbol-keyed and non-enumerable own properties (root and nested plain objects or
    arrays; an array's `length` excepted): the clone would drop them silently. `#private` fields of a
    class-instance root cannot be detected: such a ctx needs a custom checkpoint (documented).
    A primitive ctx makes the restore a no-op. A frozen root is NOT assumed immutable (freeze is
    shallow): it is accepted, with a no-op restore, only when every value under it is a primitive or
    a frozen plain object/array (recursively); a mutable child, or a Date/Map/Set/typed array, gives
    SagaUsageError "ctx is frozen but <path> is mutable, so it cannot be restored in place; provide
    retry.checkpoint".
```

### 4.1 Lock resolution (`resolveLocks`)

For each declaration, `keyOf(ctx)`:
- **String:** one request.
- **Array:** one request per element.
- **`undefined` or `[]`:** `SagaUsageError` unless the declaration has `optional: true`; with `optional: true`, no request is made.
- **Empty string key:** `SagaUsageError`.
- **More than `maxLocksPerUnit` requests after dedupe (default 64):** `SagaUsageError`, before the transaction. Every Postgres advisory lock takes a slot in the server-wide shared lock table (`max_locks_per_transaction * max_connections`), and a key list from user input (a batch of 200k ids) would otherwise fill it and fail every other session with 53200, while holding one connection for 200k round trips.
- **`keyOf` throws:** the error propagates. Nothing is retried, because no transaction has started.

The resulting requests then go through `canonicalLocks`.

### 4.2 Invariants (each has a unit test)

- **I1.** A committed unit of work is never re-run. The retry path covers only `transactions.run`, and afterCommit errors can never trigger a retry.
- **I2.** Within an Estela transaction, the runner's first statements are:
  1. the ledger claim, when one applies;
  2. all advisory locks, in one physical canonical order, once per physical lock.

  Shared and exclusive requests on the same key collapse to exclusive, so a transaction never upgrades its own lock.
- **I3.** At the start of every attempt, `RunState` and `ctx` equal their values after the last committed unit.
- **I4.** afterCommit callbacks run only for the committed attempt, once, in registration order, before the next segment and before the reply.
- **I5.** Lock keys are resolved once per unit of work, so every retry acquires the same set.

### 4.3 Deadlock-freedom argument

- **The lock prefix is never in a cycle.** All Estela advisory locks are requested in one global physical order. A wait cycle among them would need a transaction that holds a later lock while waiting for an earlier one, and the canonical prefix makes that impossible.
- **Claiming first is safe.**
  - The claim is the first statement of its transaction.
  - A transaction can only wait on another's claim row when both runs have the same idempotency key.
  - A transaction that waits on a claim row holds nothing yet, so it cannot be part of a cycle.
- **What remains.** Cycles are still possible through row locks taken in step code, or through app code outside Estela. Those deadlocks are classified (`40P01`) and retried.
- **Why claim-before-locks was chosen.** A replay or in-progress duplicate returns without taking or waiting on any advisory lock.

### 4.4 Rules of thumb (documented in the README)

- **A lock protects a unit of work. A state machine protects a saga.** Locks are released at commit and never span an outbound step. To keep an invariant across an outbound call, use CAS inside the unit to move the entity to a PENDING state.
- **Transaction steps must only touch the database.** A retry re-runs the whole step, including any other side effect.
- **Locks protect reads only under READ COMMITTED.** Under REPEATABLE READ the snapshot predates the lock wait (section 2.9, Isolation).
- **Never swallow a database error inside a step.** Postgres leaves the transaction aborted, the COMMIT silently becomes a ROLLBACK, and the saga would look successful.
- **afterCommit is not durable.** For effects that must happen, use an outbox.

## 5. Failure and interaction matrix

| Phase | Error | Policy active, kind listed, attempts left | Exhausted or kind not listed | Unclassified |
|---|---|---|---|---|
| run() checks | missing LockPort / classifier, nested-saga guard | n/a: SagaUsageError before any tx | same | same |
| resolveLocks | keyOf throws, missing or empty key | not retried (before tx) | throws as is | throws as is |
| checkpoint, first unit | ctx not cloneable / custom checkpoint throws | not retried | SagaUsageError (or the checkpoint's error) before any tx | |
| checkpoint, later unit (after an outbound: compensation, record, tx#N) | same | the unit runs ONCE without retry; hopError `checkpoint:<label>` | as without a policy | |
| run() checks | non-transactional ledger + retry + idempotency key | SagaUsageError before any tx | | |
| resolveLocks | more than maxLocksPerUnit requests | not retried (before tx): SagaUsageError | | |
| lock acquire (Postgres) | REPEATABLE READ transaction | SagaUsageError, never retried | | |
| ledger claim | `in-progress` | never retried: IdempotencyInProgressError | same | |
| ledger claim | `replay` | empty tx commits, stored reply returned, no locks, no callbacks | | |
| claim on attempt > 1 | another run committed the key in between | attempt sees replay (returns their reply) or in-progress (error), both correct | | |
| lock acquire | 55P03 / LockTimeoutError | rollback; RunState and ctx restored; backoff; same lock set | LockTimeoutError (cause, saga, unit, attempts) | raw |
| step | 40P01 / 40001 / StaleStateError (if listed) | whole unit re-run; claim redone because `claimed` was reverted | typed error; claim rolled back, so the client may retry | raw; claim rolled back |
| step | IllegalTransitionError / TransitionOutcomeUnknownError / SagaUsageError | never retried or wrapped, even if a classifier maps it to a listed kind | throws as is, rollback | |
| classifier | returns a value that is not `'lock-timeout'` / `'deadlock'` / `'serialization'` (typo, `'stale-state'`) | treated as unclassified: not retried | | raw |
| TransactionPort re-invokes `work` | (its own retry after a rollback) | each call: claim state restored, callbacks dropped, in-process locks released, ctx restored when a policy exists | | |
| record (last unit) | any | retried with its unit | | |
| COMMIT | 40001 | rollback is definite, so retry | SerializationError | |
| COMMIT | connection lost (outcome unknown) | not classified, never retried; a client retry reaches the ledger and gets replay or in-progress, so no double effect | raw | raw |
| afterCommit callback | any | n/a (committed): hopError and onAfterCommitError; the next callback runs; the saga succeeds | | |
| afterCommit after seal | | SagaUsageError at the call site (logged if called from inside a callback) | | |
| outbound | any | never retried | compensation (its own unit, retried, inherited locks), then the outbound error is rethrown | |
| compensation unit | listed kind | retried | compensation error replaces the original (0.8.0 behaviour); key stays claimed (R10) | |
| claim-only tx | listed kind | retried | typed | |
| unit after a successful outbound | listed kind | retried (atomic; the outbound is not re-run) | key left in-progress (0.8.0 semantics, R10) | |
| run() inside a step | outer unit holds locks or has a retry policy, or inner saga has locks or retry | SagaUsageError (prevents self-deadlock and broken order; an inner saga commits on its own, so a retried outer unit would commit it again) | | |
| run() inside a step | neither | allowed, as in 0.8.0 | | |
| run() inside an afterCommit callback | | allowed: outside the ALS scope | | |
| same key shared and exclusive in one segment | | one exclusive lock, no self-upgrade | | |

**Typed error messages.** A wrapped error's `message` is `<kind> in saga "<name>" unit <label> after <n> attempt(s)`. The driver error (which names relations, constraints and sometimes values) is only in `cause`, so an exception filter that echoes `message` with the 503 leaks nothing.

**Error-identity change is opt-in.** Raw driver errors are wrapped into typed errors only when a classifier is configured. Consumers that catch `QueryFailedError` today see no change until they set `classify`. ms-bpm then maps `ConcurrencyError` to 409 for `stale-state` and to 503 with `Retry-After` for the others.

## 6. Test plan

### 6.1 Unit tests (no database; extend `FakeDb`/`TxLedger` in `saga.spec.ts` with `failNext(error, phase: 'body' | 'commit')` and `classify`)

**Builder and placement**
- **U1.**
  - `.lock().outbound()`, `.transaction().lock().outbound()`, a trailing `.lock()` and `.lock().reply()` all throw `SagaDefinitionError`;
  - a lock between two transaction steps is hoisted to the segment start;
  - `.outbound().lock().transaction()` binds to the next segment;
  - `retry` validation: `attempts` 0, 21 and 1.5; negative `backoffMs`; `maxBackoffMs < backoffMs`; empty or duplicate `on`; a second `.retry()`;
  - the definition is frozen.

**Lock resolution and canonical order**
- **U2.** `canonicalLocks`:
  - the output is the same for 200 random permutations of the input;
  - exclusive beats shared, and the smallest timeout wins;
  - non-ASCII keys sort in code-unit order;
  - array keys are expanded;
  - `undefined` throws unless `optional`;
  - an empty string throws.

**Runner and locks**
- **U3.** A recording `LockPort` shows:
  - one `acquire` per segment, after the claim and before the first step;
  - none on replay;
  - a missing LockPort throws before any transaction (0 calls to `run`).

**Retry**
- **U4.**
  - a deadlock on attempt 1 succeeds on attempt 2, and the hop log shows `retry:deadlock#2`;
  - `ctx` is restored deeply with its identity kept;
  - the backoff sequence follows the `sleep` and `random` seams for each of the three jitter modes;
  - exhaustion throws `DeadlockError` with `attempts = N`, `cause`, `saga` and `unit`;
  - an unlisted kind throws a typed error with no retry;
  - an unclassified error propagates raw;
  - an outbound spy is called once even when its error is classified.

**Ledger interaction**
- **U5.**
  - **(a) Regression for the section 1 bug.** The claim rolls back, `claimed` is reverted, attempt 2 re-claims, and exactly one committed claim and one record exist.
  - **(b)** When a concurrent run completes between attempts, attempt 2 returns the replayed reply.
  - **(c)** When a concurrent run is still in progress, the result is `IdempotencyInProgressError`, not retried.

**Commit-time failure**
- **U6.** A `40001` thrown at commit is retried, and attempt 1's afterCommit callbacks never run.

**afterCommit**
- **U7.**
  - callbacks run in order, before the next segment and before `run()` resolves;
  - a throwing callback goes to `hopError` and the hook, the next callback runs, and the saga succeeds;
  - a throwing hook is swallowed;
  - the static Logger fallback is used when no logger is configured;
  - `afterCommit` after the seal throws;
  - 2-argument steps still type-check (tsd-style compile test).

**Checkpoint**
- **U8.**
  - a nested class instance or a function in `ctx` gives `SagaUsageError` with the path;
  - a frozen root with a mutable child (`Object.freeze({ created: [] })`) gives `SagaUsageError` before any transaction, never a retry on attempt-1 state; a deeply frozen root is accepted;
  - symbol-keyed and non-enumerable own properties (root or nested) give `SagaUsageError`;
  - a custom checkpoint thunk is honoured;
  - without a policy no clone is taken (spy on `structuredClone`).

**Compensation**
- **U9.**
  - with `'inherit'`, the compensation receives the exact earlier `LockRequest`s even after the outbound mutated `ctx`;
  - with `'none'`, no locks are taken;
  - compensation is retried;
  - the claim-only transaction and `finishAfterOutbound`'s record transaction are retried.

**Nested sagas and fail-fast checks**
- **U10.**
  - a nested `run()` from a step is rejected when the outer unit holds locks;
  - it is rejected when the outer unit has a retry policy, and when a lock-free, retry-free outer unit nests an inner saga with locks or with retry;
  - it is allowed when neither side uses locks or retry;
  - it is allowed from inside an afterCommit callback.
- **U11.**
  - `retry.on` with a database kind and no classifier throws;
  - `on: ['stale-state']` alone needs no classifier.

**Regression tests for the review findings**
- **U16.** Locks across retries (I5): a 40P01 on attempt 1, with a custom checkpoint that leaves the `keyOf` field mutated, re-acquires the identical set and holds nothing at the end; a `LockTimeoutError` from the port is retried with the same set; `maxLocksPerUnit` rejects 65 keys before any transaction.
- **U17.** `MemoryIdempotencyLedger` + retry + key is refused before any transaction (both the in-progress and the false-replay shapes); without retry or without a key it is accepted.
- **U18.** Checkpoint failures after a commit: compensation and ledger release still run and the outbound error survives (entity in ctx; an `Error` stored in ctx); the record unit after a successful outbound still commits; a later unit runs once.
- **U19.** Hand-built definitions: `attempts: Infinity`, `on` as a string, negative backoff and an invalid lock mode give `SagaDefinitionError` before any transaction.
- **U20.** Call sites: a `TransactionStep`, `definition.steps[i].run` and `OutboundOptions.compensate` called with two arguments are compile errors (`@ts-expect-error`); a wrapper that forwards `unit` keeps afterCommit working in a compensation; a 2-argument implementation is still accepted; `testUnitOfWork()` commits and rolls back callbacks.
- **U24.** A `TransactionPort` that re-invokes `work` after a 40001 inside one `run()`: the key is claimed again in the new transaction (one claim row, one done row), the rolled-back call's afterCommit never runs, `MemoryLockPort` is re-acquired without waiting on itself, and ctx is restored when the saga has a retry policy.
- **U25.** Classifier results that are not database kinds (`'lock_timeout'`, `'timeout'`, `'stale-state'`, `42`), from `classifyError` and from `transactions.classify`, rethrow the original error after one transaction; `toConcurrencyError` with an unknown kind throws TypeError.
- **U26.** NEVER_RETRIED: with `classifyError: () => 'serialization'` and `retry({ on: ['serialization'], attempts: 3 })`, IllegalTransitionError, TransitionOutcomeUnknownError, SagaUsageError and an in-progress ledger claim surface as is after one transaction.
- **U27.** `delayFor`: without `maxBackoffMs` the delay stops at 32 x `backoffMs` (also as the jitter bound); with a huge `backoffMs` no jitter mode exceeds 2147483647 ms (`retry-policy.spec.ts`).
- **U28.** A typed error's message holds no driver text; the driver error is its `cause`.
- **U29.** `test/dist-typescript4.spec.ts`: the built `.d.ts` files contain no TS 5-only syntax (`const` type parameters, global `NoInfer`), so they parse on TS 4.9.
- **U21.** A `ConcurrencyError` subclass loaded twice (`jest.isolateModules`) matches across copies by brand and kind and is retried; `test/dist-identity.spec.ts` checks the built CJS and ESM entries.
- **U22.** `transition()` with a misspelled `to` or `from` is a compile error (`@ts-expect-error`).
- **U23.** Postgres adapters: `idType`/`stateType` emit `$n::text::"type"` and reject invalid type names; REPEATABLE READ is rejected before any lock (allowed with the opt-out; serializable and read committed pass); a `bigint` version is read and an unreadable one throws; Prisma `P2034` maps to `deadlock`.

**Testing helpers**
- **U12.** `MemoryLockPort`:
  - shared+shared runs concurrently, while exclusive blocks;
  - FIFO order with no writer starvation;
  - `timeoutMs` gives `LockTimeoutError`;
  - locks are released on commit and on rollback;
  - `{a,b}` versus `{b,a}` 100 times concurrently gives no timeout.

**State machine and transition**
- **U13.**
  - `@ts-expect-error` on an unknown target;
  - run-time rejection of a target that is not a key;
  - `sourcesOf`, `targetsOf` and `isTerminal`;
  - an illegal request never calls the port (spy);
  - `affected` values 0, 1, undefined, null, NaN, 2, 1.5 and `"1"` map to Stale, ok, and Unknown for the rest.

**Postgres adapters with a recording fake `SqlQuery`**
- **U14.**
  - exact SQL and params;
  - `lock_timeout` is restored;
  - timeouts 0, 1.5, -1, 2^31 and NaN are rejected before any query;
  - identifiers `a; drop`, `"x"`, a 64-character name and a leading digit are rejected at construction;
  - `rowsOf` accepts an array and `{rows}` and rejects anything else;
  - `classifyPostgresError` handles the pg shape, TypeORM `driverError`, Prisma `meta.code`, a nested `cause` and the depth cap, and returns undefined for `08006` and `57014`.

**Backward compatibility**
- **U15.** The existing `saga.spec.ts` passes unchanged, and hop lines are byte-identical when nothing new is configured.

### 6.2 Postgres integration (`test/saga-postgres.e2e.spec.ts`)

- **Gating.** `const d = process.env.ESTELA_PG_URL ? describe : describe.skip`, so CI and `npm run verify` stay DB-free.
- **Local target.** `ESTELA_PG_URL=postgres://postgres:estela@localhost:55433/estela` only; no other database is touched.
- **Isolation.** Each run uses a unique throwaway schema, dropped in `afterAll`. Advisory locks share one key space per cluster, so every lock namespace (including the raw-SQL P5 control) is prefixed with that schema, and the P14 waiter probe matches only the int8 key of its own lock (`ADVISORY_LOCK_KEY_SQL`, `objsubid = 1`). The pool is capped at 16 connections, so several concurrent runs fit under `max_connections = 100`.
- **Transaction port.** A `pg.Pool` `TransactionPort` using BEGIN/COMMIT/ROLLBACK, with `classify: classifyPostgresError`.

Cases:
- **P1.** An exclusive lock serializes. A second session with `timeoutMs: 200` gets `LockTimeoutError` (55P03) after at least 200 ms. With `retry`, it succeeds once the holder commits.
- **P2.** shared+shared overlap; shared versus exclusive blocks.
- **P3.** Locks are transaction-scoped. After commit or rollback, `pg_locks WHERE locktype='advisory' AND pid = <session pid>` is empty.
- **P4.** `SHOW lock_timeout` inside the step equals the session value.
- **P5.** Canonical order:
  - 64 concurrent sagas with random lock subsets over 5 keys, random declaration order and mixed modes produce zero 40P01;
  - a control that acquires in declaration order produces 40P01, which proves the test can detect the problem.
- **P6.** Two keys that collide under 32-bit `hashtext` (found in setup via `GROUP BY hashtext(k) HAVING count(*) = 2` over `generate_series`, and asserted to collide) are distinct locks: while one saga holds the exclusive lock on the first, a saga locking the second succeeds within a 300 ms timeout, and a saga locking the first times out with LockTimeoutError. With the old `(hashtext(ns), hashtext(key))` identity the second saga would time out.
- **P6b.** Shared plus exclusive on the same key in one unit merges to one ExclusiveLock.
- **P7.** Namespaces and keys containing `'`, `$$`, `;` and unicode work as parameters.
- **P8.** CAS:
  - 20 concurrent PENDING-to-RUNNING transitions give exactly 1 success and 19 `StaleStateError`;
  - the version is bumped once;
  - an enum-typed state column and a schema-qualified table work;
  - a wrong `expectedVersion` gives Stale.
- **P9.** Opposite-order row updates in step code give 40P01; with `retry({ on: ['deadlock'] })` both sagas commit.
- **P10.** Serializable write skew gives 40001, which is retried and converges.
- **P11.** An afterCommit callback sees the committed row from another connection. It is never invoked on rollback.
- **P12.** Adapters work with a `{rows}` query function (pg) and with an array-returning one (TypeORM-style).
- **P14.** Isolation: a lock saga in a REPEATABLE READ transaction is rejected with SagaUsageError and writes nothing; control with `allowSnapshotIsolation: true`: a read-then-insert under an exclusive per-user lock inserts twice; READ COMMITTED inserts once; SERIALIZABLE with retry on serialization inserts once.
- **Holders always released.** P1, P2 and P14 release their lock-holding saga in `finally`, so a failed assertion never leaves a pooled client in an open transaction (which would hang `pool.end()`).
- **P15.** A query function that binds strings as `text` (as Prisma does): a uuid id plus an enum state fails with 42883/42804 without `idType`/`stateType`, and transitions (then reports Stale on a repeat) with them.
- **P13.** ms-bpm Start scenario: `lock('flow', id, 'shared')` plus `lock('flow-start', \`${flowId}:${userId}\`, 'exclusive')`. Different users run concurrently (wall time below 1.5 times a single run), and the same user is serialized. A Publish with `lock('flow', id, 'exclusive')` excludes all Starts.

## 7. Documentation

**README "Sagas" (concise, existing style).** Four short subsections:
- **Locks.** The ms-bpm Start/Publish example, the placement rule, and the segment-start key rule.
- **Retry.** `attempts` counts total attempts; outbound steps are never retried; checkpoint options; a classifier is required.
- **afterCommit.** The guarantee and its limits: not durable, and it does not fix reader-cache races (use versioned cache keys or a TTL).
- **State machine with `transition()`.** Postgres wiring for TypeORM, pg and Prisma.

It also adds the four rules of thumb from section 4.4.

**Skills.** No skill documents sagas today, so each change below is a new section:
- `skills/estela-flows`: the saga DSL including `lock`, `retry`, `afterCommit` and `transition`.
- `skills/estela-setup`: port wiring (`TransactionPort.classify`, `postgresAdvisoryLockPort`, `postgresTransitionPort`, `SqlQueryOf` snippets).
- `skills/estela-testing`: `MemoryLockPort`, `MemoryTransitionPort`, and fault injection with `failNext`.
- `skills/estela-review` gets these checklist items:
  - no `FOR UPDATE` used as a global mutex;
  - no plain UPDATE for state;
  - never trust a falsy update result;
  - no non-database side effects in transaction steps;
  - no swallowed database errors.

**CHANGELOG.** The entry comes from the release tooling; the version bump to 0.9.0 is not edited by hand.

## 8. Risks (accepted, documented)

- **R1. Locks taken outside Estela.** Advisory or row locks that apps take outside Estela's order void the deadlock-freedom guarantee; retry is the backstop. Estela's keys live in the single-bigint key space (`objsubid = 1`); an app's own `pg_advisory_xact_lock(bigint)` keys clash with them only by a 64-bit hash collision, which only over-serializes. Use `ADVISORY_LOCK_KEY_SQL` to take an Estela lock from raw SQL.
- **R2. Retries re-run step side effects.** Any non-database side effect inside a transaction step runs again on retry. This is a documented rule and cannot be enforced.
- **R3. Cost of the default checkpoint.** Every unit pays one deep clone, and only when a policy is set. `assertPlainGraph` turns a silent prototype loss into an early error.
- **R4. Worst-case latency.** `attempts * (sum of lock_timeout + step time) + backoff`. The lock timeout applies per lock, and `attempts` is capped at 20.
- **R5. afterCommit is not durable.** A crash between commit and callback loses the callback. A slow reader can still repopulate a stale cache; recommend versioned keys or a TTL.
- **R6. Lock identity is a 64-bit SHA-256 prefix.** `hashtext` (32 bits, non-cryptographic) was dropped: an attacker who chooses part of a key (a username in `${flowId}:${username}`) could brute-force a collision with a victim's key offline in minutes and then hold the victim's lock (targeted denial of service), so "collisions only over-serialize" held only for accidental collisions. With SHA-256 a targeted collision costs about 2^64 work and an accidental one is negligible; when one happens anyway it still only over-serializes, and the physical re-sort keeps the order canonical. Lock keys should still prefer server-assigned ids. Requires Postgres 11+.
- **R6b. TypeScript floor.** The emitted declarations must parse on TS 4.9 (consumers such as ms-asg-core pin 4.9.5, and `skipLibCheck` does not skip syntax errors). `test/dist-typescript4.spec.ts` rejects TS 5-only syntax in `dist/*.d.ts`.
- **R7. Ambient transactions.** A `TransactionPort` that joins an ambient transaction (typeorm-transactional REQUIRED propagation) makes retry unsafe and stretches locks over the outer transaction. The README states that `run` must open a new top-level transaction. PgBouncer transaction pooling is safe only because the locks are transaction-scoped.
- **R8. Compensation can time out.** Inherited locks can make a compensation time out, leaving the key claimed. Retrying compensations reduces this.
- **R9. Narrow nested-saga guard.** It covers only the lock and retry cases (outer locks, outer retry, inner locks, inner retry). A nested saga with none of them keeps 0.8.0 behaviour.
- **R10. Existing gap: key stuck in-progress.** A failure after a successful outbound leaves the key in-progress forever. A follow-up needs `onFailure` or a ledger TTL; it is out of scope for 0.9.0.
- **R11. Custom query functions.** One whose result `rowsOf` cannot read gets `UnexpectedQueryResultError` or `TransitionOutcomeUnknownError`, and the message says how to adapt it.
- **R12. `::text` cast and indexes.** `"state"::text` prevents an index on state; the primary-key lookup on id makes this acceptable.
- **R13. Release type.** The third step argument, `hopError`, `TransactionPort.classify` and the `locks` field are all additive. Typed wrapping is opt-in, so this is a minor release (0.9.0).
- **R14. Isolation level.** Advisory locks protect reads only under READ COMMITTED. The Postgres port rejects REPEATABLE READ; a custom LockPort on another database must document the same caveat.
- **R15. Degraded checkpoint.** A later unit whose ctx cannot be snapshotted runs without retry; the failure is logged (hopError), not thrown.

## 9. Decisions log (both designs' open questions, resolved)

| # | Question | Decision | Reason |
|---|---|---|---|
| D1 | `lock` as a third `SagaStep` kind, or a field on transaction steps | Field (`locks?`) on transaction steps | Keeps consumers' exhaustive switches compiling |
| D2 | Lock binding direction | Forward only; otherwise SagaDefinitionError | Reads top-down; no surprise backward hoisting |
| D3 | Default lock mode | None: `mode` is required | An implicit exclusive recreates the global-mutex incident |
| D4 | `keyOf` returning undefined | Error unless `optional: true` | A silently skipped lock is a silent race |
| D5 | Where classification lives | `TransactionPort.classify?` plus a `SagaRunnerOptions.classifyError` override | The database owns its error codes; deadlocks come from steps, not from locks |
| D6 | Claim before or after locks | Claim first | Replays take no locks; deadlock-free (section 4.3) |
| D7 | Lock keys on retry | Resolved once per unit (I5) | The same set on every attempt; ctx is restored anyway |
| D8 | Checkpoint API | `'clone'` (default, validated) or a function returning a restore thunk; no `'shallow'` | Shallow does not revert nested mutations |
| D9 | Retry scope | One saga-level policy applied to every unit (main, claim-only, compensation, record) | Simple; every unit is atomic |
| D10 | Typed wrapping | Only when a classifier is set; pre-typed errors are rethrown as is | Backward compatible |
| D11 | CAS port return type | `CasResult { affected, version? }` | Extensible; returns the new version |
| D12 | CAS count not 0 or 1 | TransitionOutcomeUnknownError (also for `> 1`) | Never silent success; never mistaken for stale |
| D13 | Postgres lock ordering under hash collisions | Hash round trip plus client re-sort by physical id | Provable canonical order |
| D14 | `lock_timeout` setting | `set_config(..., true)` with bound params, restored afterwards | Injection-free; does not leak into step row locks |
| D15 | Retry and afterCommit logging | Existing hopStart/hopEnd plus one additive `hopError` | Minimal HopLogger growth; failures never silent |
| D16 | Nested saga | Rejected only when locks or retry are involved | Safety without breaking 0.8.0 nesting |
| D17 | Compensation locks | `compensateLocks: 'inherit'` by default | The compensation touches the same rows the segment protected |
| D18 | Barrel exposure of the Postgres adapters | Main barrel, guarded by a depcruise no-npm rule | Zero dependencies; one import path |
| D19 | MemoryLockPort release | `LockScope.onRelease` in `LockPort.acquire` | No `TransactionPort` wrapper needed |
| D20 | `attempts` and backoff bounds | `attempts` 1..20; `maxBackoffMs` default `backoffMs * 32`; jitter default `'full'` via `node:crypto` | Bounded latency; avoids the sonarjs pseudo-random hotspot |
| D21 | Snapshot isolation and advisory locks | Reject REPEATABLE READ in the Postgres port (`allowSnapshotIsolation` opt-out) | The snapshot predates the lock wait: a silent duplicate otherwise |
| D22 | Non-transactional ledger with retry | Refused at run() via `IdempotencyLedger.transactional === false` | A surviving claim breaks section 1's revert |
| D23 | Checkpoint failure | Fatal only for the first unit; later units run once, logged | Never block a compensation, record or post-outbound unit |
| D24 | Nested guard | Also rejects when the OUTER unit has a retry policy | The inner saga commits on its own and would be re-run |
| D25 | Class identity across CJS entries | Brand + `Symbol.hasInstance`, not CJS code splitting | tsup's CJS splitting renames classes |
| D26 | Definitions as plain objects | Retry policy and lock declarations re-validated at run() | `SagaDefinition` is a public interface |
| D27 | `TransactionStep` third parameter | Required on the call side; 2-argument implementations still assignable; `testUnitOfWork()` for direct calls | An optional `unit` let a wrapper that drops it type-check and then crash at run time; a compile error is the honest outcome |
| D28 | Advisory lock identity | One int8 = first 64 bits of SHA-256(length(ns) ':' ns key), computed in SQL | 32-bit `hashtext` collisions can be crafted from user-chosen key text |
| D29 | Typed error message | kind, saga, unit and attempts only; driver text only in `cause` | Apps map these errors to HTTP responses |
| D30 | Classifier results | Only database kinds count; anything else is unclassified | A classifier is user code; a typo must not turn into a TypeError that loses the driver error |
| D31 | Port re-invoking `work` | Supported: per-call reset of claim, callbacks, in-process locks (and ctx under a policy) | Common wrapper pattern; the contract never forbade it |
| D28 | Lock count per unit | `maxLocksPerUnit`, default 64 | Shared lock table is server-wide |
| D29 | Prisma P2034 | Mapped to `deadlock`; docs: list both kinds | No SQLSTATE on the ORM error |
