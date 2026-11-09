# Estela 0.10: multi-replica correctness spec

Status: draft, revised after the SDD review of 2026-11-09; not implemented. Base: `20ae298` (`chore(release): 0.9.0`), branch
`docs/SPI-428-koletz-readiness-specs`. Ticket: **SPI-429** (epic SPI-428). Requirement prefix: `MR-`.
Supersedes section 3 of the combined Koletz readiness draft (`2026-11-09-estela-koletz-readiness.md`
in the voice-plat repo). Resilience (timeouts, breakers, retry budgets: `ESTELA_RESILIENCE_SPEC.md`,
ticket placeholder SPI-RES, prefix `RS-`) and sensitive-data redaction (`ESTELA_SENSITIVE_DATA_SPEC.md`,
SPI-433, prefix `SD-`) are separate specs and are referenced, never redefined, here. This spec is
generic library behaviour: every adopter rule (which services enable the guard, which store, which
keys are digested) lives in the Koletz adoption spec (`2026-11-09-estela-adoption-koletz.md`, prefix
`KA-`).

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

## 0. Motivation and scope

### 0.1 What is wrong today (verified at `20ae298`)

Every piece of runtime state in Estela lives in the memory of one Node process:

| Finding | Evidence | Effect with two or more pods |
|---|---|---|
| Channels are in-process objects; the kinds are a closed union of in-memory kinds | `src/channel.ts:10`, `src/channel-factory.ts:23-37` | A message sent in pod A never reaches pod B. This is by design and stays so. |
| The default idempotency store is `MemoryIdempotencyStore` | `src/idempotency/idempotency.service.ts:139-144` | A client retry that lands on another pod is not recognised as a duplicate: the side effect runs twice. |
| A shared store exists only as a README snippet | `README.md:155-173` | Every consumer writes its own Redis store; the snippet has no owner check, no unavailability handling and no tests. |
| `complete`/`fail` do not check who owns the claim | `src/idempotency/memory-idempotency.store.ts:50-62` | Copied to Redis, a pod whose claim expired and was retaken by another pod overwrites the new owner's record. |
| `QueueChannel` is a process buffer: `send` resolves once the message is buffered, a pump delivers it later, and only a graceful shutdown drains what is left | `src/channels/queue.channel.ts:29-72`, `src/integration.module.ts:288-293` | A crash or OOM kill loses every buffered message silently. |
| Fire-and-forget inbound marks the key completed as soon as the message is buffered | `src/inbound/inbound.interceptor.ts:156,166` | With a `queue` target, a crash loses the work and the completed key blocks the client retry until the TTL. |
| Request/reply waits on an in-process `reply.<uuid>` channel | `src/gateway/reply-gateway.ts:28-61` | A reply produced in another process can never reach the waiter. |
| `replyChannel` is never written to a wire | `src/adapters/header-mapper.ts:53-62` (only trace headers and `idempotency-key`) | Request/reply cannot leave the process even by accident: a path that does times out. This is the property this spec keeps. |
| Saga test ports are process-local | `src/testing/memory-lock-port.ts:14-20`, `src/saga/idempotency-ledger.ts:44-52` | `MemoryLockPort` does not exclude another pod; `MemoryIdempotencyLedger` does not see another pod's claims. |
| A failing `begin` propagates the raw driver error | `src/inbound/inbound.idempotency.ts:223`, `src/flow/flow-executor.ts:64-67`, `src/activator/activator-wrapper.ts:85-86` | No typed "store unavailable" error, no policy, no event. |
| A failing `get` on a repeat propagates too | `src/inbound/inbound.idempotency.ts:226`, `src/activator/activator-wrapper.ts:167` | A store that answers `begin` but fails `get` turns a duplicate into a raw error. |
| A failing `complete` in a flow or activator after the work ran goes to the error channel and is rethrown | `src/flow/flow-executor.ts:68-84`, `src/activator/activator-wrapper.ts:98-113` | The caller sees a failure for work that was done; an inbound `onFailure` classifier could then release the inbound key and let a retry run the work again. |

### 0.2 Premise (verified 2026-11-09)

The first adopters (Koletz `ms-ai-core` and `ms-campaigns`) run **one replica each in dev and qa, with
no HPA**. Multi-replica is therefore a **scaling risk, not a current outage**. Priority **P1** (the
epic table still lists SPI-429 as P0: OQ-8). The library's part of the rule "no scaling onto
process-local state" is the boot guard (section 4.5), which therefore ships in this ticket; enabling
it in each adopter before any replica count above one or any HPA is an adopter requirement (KA-01 to
KA-03), not a requirement of this spec.

One caveat keeps the risk from being zero today: a Deployment with one replica and the default
rolling update (`maxSurge` 25%, rounded up to one pod) runs two pods for the length of every rollout,
each with its own memory store. A client retry that lands on the new pod during that window is not
recognised as a duplicate (R11).

### 0.3 Scope (one deliverable: SPI-429)

1. `RedisIdempotencyStore`: Redis client injected as a command port, no npm import.
2. `PostgresIdempotencyStore`: query function injected, migration SQL shipped as a string, batched purge.
3. Owner-fenced, atomic `begin`/`complete`/`fail`/`release`/`get` with defined TTL semantics.
4. Defined behaviour when the store is unavailable: typed retryable error, fail-closed by default,
   fail-open only for scopes that are not side-effecting (D-REDIS-DOWN).
5. A boot guard (`forRoot({ replicas })` / `ESTELA_REPLICAS`) that reports, and in strict mode
   refuses, process-local state in a multi-replica deployment.
6. Request/reply stays process-local; the rule is documented and locked by a test.
7. One event path for store health (`observe`), so the module logs and forwards what a store reports.
8. A store contract suite and a two-instance e2e test.

### 0.4 Non-goals

- **Durable, broker-backed channels and cross-pod request/reply: deferred to SPI-434.** No requirement
  here depends on them. Until then, a `queue` channel is best-effort and the whole request/reply path
  runs in one pod.
- Retry, timeouts, circuit breakers, rate limiters and retry budgets for remote calls: the resilience
  spec (SPI-RES; the budget is RS-28 to RS-31). This spec only states that the stores never retry
  (MR-11) and that no layer defined here retries.
- Redaction of stored records: SPI-433. It seals or strips records **above** the store and keeps the
  `IdempotencyStore` contract unchanged (SD-35), so this spec adds no codec hook. It provides only the
  serialization floor of `fail` (MR-08) and an optional key digest (MR-19).
- Shared state for rate limiters and breakers (the other half of D-REDIS-DOWN): the resilience spec.
- A shipped `IdempotencyLedger` or a Redis-backed `LockPort` for sagas. Estela ships a cross-pod lock
  port (`postgresAdvisoryLockPort`, `src/saga/postgres/advisory-lock-port.ts:195`); a production
  ledger is written by the app over its own database (`src/saga/idempotency-ledger.ts:9-26`). This
  spec only makes the guard see the in-memory ports.
- Leader election, singleton jobs, scheduler inbound: SPI-441.
- Performance numbers. Overheads are measured and budgets set in SPI-444; the only number defined
  here is a provisional default for `operationTimeoutMs` (OQ-3), labelled as such like the
  provisional defaults of the sibling specs.
- Outbound REST `retry`/`timeoutMs`: untouched (section 1.3); their alias semantics are RS-34.
- Adopter configuration (which services set `ESTELA_REPLICAS`, which channels are `sideEffects`,
  whether keys are digested): the Koletz adoption spec.

## 1. Backward-compatibility contract

### 1.1 Unchanged by default

An application that sets neither `replicas` nor `ESTELA_REPLICAS`, and keeps the default memory
store, behaves byte-for-byte as in 0.9.0:
- same claims, same repeat answers, same errors, same hop log lines;
- no new boot log line (MR-27);
- `MemoryIdempotencyStore`, `NoopIdempotencyStore`, `MemoryLockPort` and `MemoryIdempotencyLedger`
  keep their behaviour; they only gain a read-only `visibility` property;
- every existing test passes unmodified.

### 1.2 Additive changes only (release type: `feat`, minor 0.10.0)

| Public type | Addition | Why it is not breaking |
|---|---|---|
| `IdempotencyStore` | `readonly visibility?: StateVisibility`, `readonly requiresPurge?: boolean`, `observe?(listener)` | Optional members; custom stores compile unchanged. |
| `IdempotencyService` | `claim(...)`, `visibility` getter | New members on a class; existing members unchanged. |
| `FlowIdempotencyPort` | `claim?(...)` | Optional; the executor falls back to `begin` when absent. |
| `ChannelSpec` | `delivery?`, `sideEffects?` | Optional fields. |
| `IntegrationModuleOptions` | `replicas?` | Optional. |
| `IntegrationIdempotencyOptions` | `onStoreUnavailable?`, `purgeIntervalMs?`, `onEvent?` | Optional. |
| `InboundIdempotencyOptions` | `onStoreUnavailable?` | Optional. |
| `LockPort`, `IdempotencyLedger` | `readonly visibility?: StateVisibility` | Optional. |
| `SagaRunnerOptions` | `replicas?` | Optional. |

No existing export is renamed, removed or narrowed, and no header or reply-channel contract changes.
The internal `InboundClaim` union (not exported, `src/index.ts:65` exports only `encodeInboundKey`)
gains an optional `at` on its `skipped` variant (section 3.11).

### 1.3 Behaviour changes, and when they apply

- A store that throws `IdempotencyStoreUnavailableError` (only the new stores, or a custom store that
  opts in) now goes through the unavailability policy (section 4.4). The memory store never throws.
- A store that throws any `IdempotencyStoreError` on a repeat lookup (`get` after a refused `begin`)
  is now answered as in flight instead of propagating (MR-37); a store `IdempotencyStoreError` that
  reaches the inbound failure policy is always `keep` (MR-35). Both apply only to the new error
  classes, which no 0.9.0 store throws.
- Invalid values of the new options throw `TypeError` from `forRoot` (MR-36). The options are new,
  so no 0.9.0 configuration sets them.
- With `replicas: 'multi'` (option or env), boot logs findings; with `strict`, boot fails on error
  findings. Both are opt-in.
- An invalid `ESTELA_REPLICAS` value fails boot (MR-22). The variable is new, so no deployment sets it
  today.
- **Outbound REST `retry` and `timeoutMs` are not touched.** Their migration to the resilience policy
  model belongs to the resilience spec. Nothing in this spec changes how many times an outbound call
  is attempted.
- The emitted `.d.ts` stays parseable by TypeScript 4.9 (`test/dist-typescript4.spec.ts`).

### 1.4 Migration

**From the README Redis snippet (`README.md:155-173`) to `RedisIdempotencyStore`.**
- The snippet writes raw keys (`scope::key`) with the plain value `in-flight`; the shipped store writes
  `keyPrefix + scope::key` with a JSON value. The two never read each other's keys, so during a
  rolling deploy an old pod and a new pod do not see each other's claims, and completed records
  written by the snippet are not replayed by the new store. Accepted window: one TTL, the same
  exposure as R11. A service that cannot accept it scales to zero (or drains traffic) for the switch.
  Sharing one key space between the snippet and the shipped store is not supported: their value
  formats differ.
- A copied snippet declares no `visibility`, so in `multi` it is an error finding
  (`UNKNOWN_STORE_VISIBILITY`). Declaring `visibility: 'shared'` on it silences the guard but does
  not add fencing; replacing it is the supported path.

**From the default memory store.** Configure the shared store and set `ESTELA_REPLICAS=multi` in the
same release; strict mode can be turned on once the non-strict boot logs show no error finding.

**Outbound REST `retry` and `timeoutMs`.** Nothing to migrate in this ticket. They keep 0.9.0
semantics; the resilience spec makes them aliases of its policy model (RS-34) and owns any
migration guidance.

## 2. Requirements

Each requirement has one acceptance criterion (Given/When/Then) and names the test that covers it.
Test ids are defined in section 8. Ticket for all rows: SPI-429, unless marked.

### 2.1 Shipped stores

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| MR-01 | MUST | Ship `RedisIdempotencyStore` implementing every member of `IdempotencyStore`, including `release`, over an injected `RedisCommand` port, with zero npm imports. | Given a store over a fake `RedisCommand`; when each port method is called; then exactly the commands of section 4.2 are sent, and dependency-cruiser reports no npm import under `src/idempotency/redis/`. | RU1, RU2, BND1 |
| MR-02 | MUST | Ship `PostgresIdempotencyStore` over an injected `SqlQuery`, with zero npm imports, and `postgresIdempotencyMigrationSql()` returning the DDL as a string. | Given the migration applied to a fresh schema; when the store runs begin/complete/get/release/purge; then each returns the documented value, and no npm import exists under `src/idempotency/postgres/`. | PU1, PE1, BND1 |
| MR-03 | MUST | `begin` is atomic across processes: for one live `(scope, key)`, exactly one of any number of concurrent `begin` calls resolves `true`. | Given two store instances on one Redis (or Postgres); when 50 concurrent `begin` calls race on one key; then exactly one resolves `true`. | RE1, PE2 |
| MR-04 | MUST | `complete`, `fail` and `release` are owner-fenced: they change the record only when this store instance took the current claim and the record is in the expected state (section 4.1). A fenced-out call changes nothing and emits `claim-lost`. | Given A's claim expired and B re-claimed the key; when A calls `complete`; then B's record is unchanged, A's call resolves, and one `claim-lost` event is emitted. | RU3, PU3, CT6, E5 |
| MR-05 | MUST | TTL is measured on the store's clock from `begin`; an expired record of any status is absent for `get` and claimable by `begin`; `complete` and `fail` keep the remaining TTL unless `retainCompletedMs` is set. | Given `begin(ttl=200ms)` then `complete` at 150 ms; when `get` runs at 250 ms; then it resolves `undefined` and a new `begin` resolves `true`. | RE2, PE3, CT4 |
| MR-06 | MUST | `ttlMs` is validated before any I/O by the two shipped stores: an integer in 1..2147483647, else `TypeError`. (The memory store keeps its 0.9.0 behaviour and does not validate.) | Given `ttlMs` of 0, 1.5, `NaN` or 2^31; when `begin` is called; then it rejects with `TypeError` and no command is sent. | RU4, PU4, CT7 |
| MR-07 | MUST | `result` round-trips as JSON; a result that `JSON.stringify` rejects (BigInt, cycle) makes `complete` reject with `IdempotencyStoreError` and leaves the record in flight. | Given a claim; when `complete` gets `{ cachedResult: 1n }`; then it rejects with `IdempotencyStoreError` (not retryable) and `get` reports `in-flight`. | RU5, PU5 |
| MR-08 | MUST | `fail` stores only `serializeError(error)` (`name`, `message`, or `{ value }` for a non-Error), never the stack, `cause` or own properties. | Given an `Error` with a stack, a `cause` and an `apiKey` property; when `fail` stores it; then the stored JSON has exactly `name` and `message`. | RU6, PU6 |
| MR-09 | MUST | A stored value that cannot be parsed or has an unknown `status` is read as `in-flight`, never as absent, and emits `record-corrupt`. | Given a Redis value `not-json` under the key; when `get` runs; then it resolves `{ status: 'in-flight' }` and `begin` resolves `false`. | RU7, PU7 |
| MR-10 | MUST | A transient failure rejects with `IdempotencyStoreUnavailableError`: a transport failure (Node socket codes `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`; Redis `LOADING`, `READONLY`, `CLUSTERDOWN`, `TRYAGAIN`, `MASTERDOWN`, `BUSY`; Postgres SQLSTATE class `08`, `53300`, `57P01`..`57P03`, `57014`, `40001`, `40P01`, read from the error and its `driverError`/`meta`/`cause` chain as `classifyPostgresError` does), or an operation that exceeds `operationTimeoutMs`. It rejects with `IdempotencyStoreUnavailableError` (`retryable: true`, driver error in `cause` only). Every other failure rejects with `IdempotencyStoreError` (`retryable: false`). | Given a `RedisCommand` that rejects with `ECONNREFUSED`, and one that never settles; when `begin` runs; then both reject with `IdempotencyStoreUnavailableError`, the second after `operationTimeoutMs`, and `message` contains no driver text. | RU8, RU9, PU8 |
| MR-11 | MUST | Stores never retry: each port call sends exactly one command or one script (Postgres: one statement). Retrying is the caller's decision. | Given a command port that fails once and then succeeds; when `begin` runs; then it rejects and the port saw exactly one call. | RU10, PU9 |
| MR-18 | SHOULD | `RedisIdempotencyStore` takes a `keyPrefix` (default `estela:idem:`); the Redis key is `keyPrefix + idempotencyStorageKey(scope, key)`. | Given `keyPrefix: 'svc:'`; when `begin('s', 'k')` runs; then the command targets `svc:s::k`. | RU1 |
| MR-19 | MAY | Both stores take a synchronous `keyDigest(storageKey): string` hook whose output replaces `scope::key` in the stored key, so raw keys never reach the store. A digest that throws or returns an empty or non-string value rejects the call with `IdempotencyStoreError` (`retryable: false`) before any I/O. | Given `keyDigest: hmac`; when `begin('s', '+50255501234')` runs; then the number appears in no command argument. Given a digest that throws; when `begin` runs; then it rejects with `IdempotencyStoreError` and no command is sent. | RU11, PU10 |
| MR-21 | MAY | `retainCompletedMs` gives completed and failed records their own TTL, counted from the settle. | Given `retainCompletedMs: 1000` and `ttlMs: 100`; when `complete` runs at 50 ms; then `get` at 500 ms still returns the record. | RE3, PE4 |
| MR-34 | MUST | The built-in process-local implementations declare `visibility: 'process'` (`MemoryIdempotencyStore`, `MemoryLockPort`, `MemoryIdempotencyLedger`, `NoopIdempotencyStore`); the Redis and Postgres stores declare `'shared'`, and the Postgres store declares `requiresPurge: true`. | Given each class; when its `visibility` is read; then it has the documented value. | GU1 |

### 2.2 Store unavailable (D-REDIS-DOWN, idempotency half)

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| MR-12 | MUST | Default policy is fail-closed: when `begin` rejects with `IdempotencyStoreUnavailableError`, nothing is dispatched. Inbound rethrows the error, so the client gets a retryable answer; flows and activators do not run their steps and rethrow it. On a `queue`, `pubsub` or `fanout` source the rethrow reaches the channel's error hook, so the message goes to the error channel and is not redelivered (there is no broker); the 0.9.0 contract for handler errors on those channels. | Given a store whose `begin` is unavailable; when an inbound request, a flow message and an activator message with a key arrive; then no handler or step runs and each caller receives `IdempotencyStoreUnavailableError`. | SU1, SU2, SU3, E4 |
| MR-13 | MUST | A scope bound to a channel with `sideEffects: true` is always fail-closed. An explicit `onStoreUnavailable: 'fail-open'` on such an inbound endpoint is a `ReplicaConfigError` at boot; a module default of `'fail-open'` is overridden to fail-closed for such scopes and logged once at boot. | Given channel `pay` with `sideEffects: true` and `@InboundRest({ channel: 'pay', idempotency: { onStoreUnavailable: 'fail-open' } })`; when the app boots; then boot fails with `ReplicaConfigError` naming `pay`. | GU8, SU4 |
| MR-14 | MUST | `onStoreUnavailable: 'fail-open'` (module or endpoint) lets a scope that is not side-effecting run without a claim: no `complete`/`fail`/`release` is called for that run and a `fail-open` event is emitted. An inbound bypass forwards the idempotency key downstream exactly as an acquired claim would (`forward: 'resolved'` included), so a downstream side-effecting scope still claims it and fails closed. | Given fail-open on a plain channel and an unavailable store; when a request with a key arrives; then the handler runs once, no settle call reaches the store, and one `fail-open` event is emitted. Given `forward: 'resolved'`; then the dispatched message carries the resolved key. | SU5 |
| MR-15 | MUST | A store failure after a successful `begin` never re-runs work and never releases the key. A failing `complete` keeps 0.9.0 semantics: inbound tries `fail` and rethrows (`inbound.idempotency.ts:231-240`); a flow or activator tries `fail`, reports to the error channel and rethrows (`flow-executor.ts:78-84`, `activator-wrapper.ts:107-113`). The key ends `failed` when that `fail` succeeds and stays `in-flight` when it fails too; either way a repeat within the TTL is not run. | Given `begin` succeeds and `complete` is unavailable; when the request finishes; then the caller gets the error, `release` was not called, and a retry with the same key within the TTL is not dispatched (answered as in flight or as a failed duplicate). | SU6 |
| MR-16 | MUST | Store health is observable without leaking data. Each shipped store tracks its own availability and emits `unavailable` on the first transient failure after a success (or after construction) and `recovered` on the first success after that; it emits `claim-lost` and `record-corrupt` as they occur, and delivers every event to each listener registered with `observe` (section 3.7). At `onApplicationBootstrap` the module observes every distinct store it uses (module and endpoint stores); it logs one warn line per `unavailable`/`recovered`, one error line per `claim-lost`/`record-corrupt`/`purge-failed`, and forwards every event to `idempotency.onEvent`. No log line or event carries a key, a result, an error message or driver text. A listener that throws is caught; its first throw is logged once and the call outcome is unchanged. | Given 100 failing `begin` calls followed by one success; when the logs are read; then there is one `unavailable` line and one `recovered` line, and no line contains the key. Given a listener that throws; when an event fires; then the store call resolves as without the listener. | RU12, PU11, SU7 |
| MR-17 | MUST | `PostgresIdempotencyStore.purgeExpired()` deletes at most `purgeBatchSize` expired rows per call using `SKIP LOCKED` and returns the count. `idempotency.purgeIntervalMs` runs `purgeExpired()` of every distinct store with `requiresPurge: true` (module and endpoint stores) on one unref'd timer started at `onApplicationBootstrap`, stops it on shutdown, and turns a purge error into a `purge-failed` event, never a crash. Every pod runs the timer; `SKIP LOCKED` keeps concurrent purgers from deleting a row twice. | Given 2 500 expired rows and `purgeBatchSize: 1000`; when `purgeExpired` runs three times; then it returns 1000, 1000, 500. Given a purge that throws; when the timer fires; then the app keeps running and one `purge-failed` event is emitted. | PE5, SU8 |

### 2.3 Boot guard

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| MR-22 | MUST | The replica mode comes from `forRoot({ replicas })` and from `ESTELA_REPLICAS` (`single` or `multi`) and `ESTELA_REPLICAS_STRICT` (`true` or `false`). The effective mode is `multi` when either source says `multi`; strict is on when either source turns it on. Values are compared after trimming whitespace and are case-sensitive; an unset variable and an empty string (a common rendering of an empty ConfigMap key) both mean "not set". Any other value of either variable, or an invalid `replicas` option, throws `ReplicaConfigError` from `forRoot`, strict or not. | Given `ESTELA_REPLICAS=multiple`; when `forRoot` runs; then it throws `ReplicaConfigError` naming the variable and the accepted values. Given option `'single'` and env `multi`; then the effective mode is `multi`. Given `ESTELA_REPLICAS=''`; then the option decides. | GU2 |
| MR-23 | MUST | In `multi`, an enabled idempotency store (module store, or an endpoint store, including a `{ useExisting }` ref resolved at bootstrap) whose `visibility` is not `'shared'` is an error finding (`PROCESS_LOCAL_IDEMPOTENCY_STORE`, or `UNKNOWN_STORE_VISIBILITY` when undeclared). A ref that cannot be resolved is an error finding (`STORE_REF_UNRESOLVED`). | Given `multi` and the default memory store; when the app boots; then one error finding `PROCESS_LOCAL_IDEMPOTENCY_STORE` names the module store. | GU3, E6 |
| MR-24 | MUST | A channel of any of the four in-memory kinds with `delivery: 'must-not-lose'` is an error finding in `multi` and a warning in `single` (`IN_MEMORY_MUST_NOT_LOSE`); a `queue` channel without `delivery` is a warning in `multi` (`UNDECLARED_QUEUE_DELIVERY`); `delivery: 'best-effort'` is silent. | Given `multi`, queues `a` (must-not-lose), `b` (undeclared), `c` (best-effort) and direct `d` (must-not-lose); when the app boots; then findings are error for `a` and `d`, warning for `b`, none for `c`. | GU4 |
| MR-25 | MUST | `SagaRunner` resolves the replica mode from `SagaRunnerOptions.replicas` and the same variables; in `multi`, a `locks` port or a `ledger` whose `visibility` is `'process'` is an error finding, logged at construction through the saga tracer's Nest `Logger` (`EstelaSaga`, `src/saga/saga-tracer.ts:7`); in strict mode the constructor throws `ReplicaSafetyError`. | Given `ESTELA_REPLICAS=multi`, `ESTELA_REPLICAS_STRICT=true` and `new SagaRunner({ locks: new MemoryLockPort(), ... })`; when it is constructed; then it throws `ReplicaSafetyError` with code `PROCESS_LOCAL_LOCK_PORT`. | GU5 |
| MR-26 | MUST | Strict mode fails boot with one `ReplicaSafetyError` that lists every error finding; non-strict mode logs each finding and boots. Warnings and infos never fail boot. | Given strict `multi` with two error findings and one warning; when the app boots; then `init()` rejects with `ReplicaSafetyError` whose `findings` has the two errors, and the warning is logged. | GU6, E6 |
| MR-27 | MUST | In `single` mode with no `delivery` declared anywhere and no `requiresPurge` store, the guard logs nothing and changes nothing. | Given the 0.9.0 example app; when it boots; then the boot log lines are identical to 0.9.0. | GU7 |
| MR-28 | SHOULD | The checks are a pure exported function, `assessReplicaSafety(input): ReplicaFinding[]`, used by the module and by `SagaRunner`. | Given a hand-built input; when it is called; then it returns findings without touching Nest or the environment. | GU1-GU5 |
| MR-29 | SHOULD | A store with `requiresPurge: true` and no `purgeIntervalMs` is a warning in both modes (`PURGE_NOT_CONFIGURED`). | Given the Postgres store without `purgeIntervalMs`; when the app boots; then one warning names the store. | GU9 |

### 2.4 Request/reply stays local

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| MR-30 | MUST | No `HeaderMapper.mapOut` writes `replyChannel` (or any header that names an in-process channel) to a wire. | Given a message with `replyChannel: 'reply.x'`; when each shipped mapper (HTTP, gRPC, AMQP, GraphQL) maps it out; then no output key or value contains `reply.x`. | HU1 |
| MR-31 | MUST | The README and the setup skill state that the whole request/reply path (inbound, flow, activators, reply) runs in the pod that received the request, that a path leaving the process ends in `ReplyTimeoutError`, and that cross-pod reply needs durable, broker-backed channels (planned). | Given the README "Multiple replicas" section and `skills/estela-setup/SKILL.md`; when DOC1 reads them; then both contain the single-pod rule and `ReplyTimeoutError`. | DOC1, E7 |

### 2.5 Testing

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| MR-32 | SHOULD | `@estela/nest/testing` exports `idempotencyStoreContract(options)`: a runner-agnostic list of named cases (`{ name, run(factory) }`) that any store can execute. Cases that need a capability the memory store does not have (cross-instance fencing, `ttlMs` validation, the `serializeError` floor) run only when the option enables them. | Given the memory store with every capability off, and both shipped stores with every capability on; when the contract runs; then every enabled case passes and the disabled ones are reported as skipped. | CT1-CT8 |
| MR-33 | MUST | A two-instance e2e suite runs two Nest apps against one shared store: always with a shared in-process fake, and against Redis and Postgres when `ESTELA_REDIS_URL` / `ESTELA_PG_URL` are set. | Given the suite; when it runs in CI without those variables; then the fake-backed cases run and pass, and the backend cases are skipped, not failed. | E1-E7 |

### 2.6 Edges

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| MR-35 | MUST | An `IdempotencyStoreError` (either class) that reaches the inbound failure policy from a downstream hop is settled as `keep`, whatever `onFailure` says: the inbound cannot tell whether work already ran downstream. | Given an inbound with an `onFailure` classifier that releases every error, and a downstream activator whose `complete` is unavailable; when the request fails; then `release` is not called on the inbound key. | SU9 |
| MR-36 | MUST | `forRoot` validates the new options and throws one `TypeError` naming the option and the accepted values: `onStoreUnavailable` (`fail-closed` or `fail-open`, module and endpoint), `purgeIntervalMs` (integer 1000..2147483647), `ChannelSpec.delivery` (`best-effort` or `must-not-lose`), `ChannelSpec.sideEffects` (boolean). Store constructors validate their own options the same way (`operationTimeoutMs` and `purgeBatchSize` integers in range, `keyPrefix` a string, identifiers through `quoteIdentifier`). | Given `purgeIntervalMs: 10`; when `forRoot` runs; then it throws `TypeError` naming `idempotency.purgeIntervalMs`. Given `operationTimeoutMs: 0`; when the Redis store is constructed; then it throws `TypeError`. | GU10, RU13, PU1 |
| MR-37 | MUST | A repeat lookup that fails is never treated as free: when `get` after a refused `begin` rejects with any `IdempotencyStoreError`, inbound answers as for an in-flight record (`onInFlight`), and the activator duplicate path sends no cached reply and returns. A non-store error from `get` propagates as in 0.9.0. | Given `begin` resolves `false` and `get` rejects with `IdempotencyStoreUnavailableError`; when an inbound with `onInFlight: 'reject'` handles the repeat; then it throws `InboundIdempotencyInFlightError` and nothing is dispatched; when an activator handles it; then the method is not invoked and no reply is sent. | SU10 |
| MR-38 | SHOULD | `IdempotencyStoreError` and `IdempotencyStoreUnavailableError` carry a `Symbol.for` brand with a `Symbol.hasInstance` fallback, like `ConcurrencyError` (`src/saga/concurrency-errors.ts:22,45`), so `instanceof` holds across the ESM and CJS bundles. | Given an error built by the testing bundle; when checked with `instanceof` against the main bundle class; then it is true. | DI1 |

Requirement count: 37 (MR-01 to MR-38; MR-20 is retired, D17).

## 3. Public API by file

### 3.0 File layout

```
src/state-visibility.ts                                   new   StateVisibility type
src/sql/sql.ts                                            new   SqlQuery, rowsOf, quoteIdentifier (moved)
src/saga/postgres/sql.ts                                  edit  re-exports src/sql/sql.ts unchanged
src/idempotency/idempotency-store.ts                      edit  visibility?, requiresPurge?, observe?
src/idempotency/idempotency-errors.ts                     new   IdempotencyStoreError, ...UnavailableError
src/idempotency/idempotency-events.ts                     new   event union, listener type, fan-out helper
src/idempotency/redis/redis-idempotency.store.ts          new   RedisIdempotencyStore, RedisCommand
src/idempotency/redis/redis-scripts.ts                    new   settle and release Lua text (constants)
src/idempotency/postgres/postgres-idempotency.store.ts    new   PostgresIdempotencyStore
src/idempotency/postgres/postgres-idempotency.sql.ts      new   statements, migration SQL, SQLSTATE table
src/idempotency/idempotency.service.ts                    edit  claim(), visibility, policy
src/idempotency/memory-idempotency.store.ts               edit  visibility = 'process'
src/idempotency/noop-idempotency.store.ts                 edit  visibility = 'process'
src/inbound/inbound.idempotency.ts                        edit  policy in claim(), MR-35, MR-37
src/flow/flow-executor.ts                                 edit  uses claim() when present
src/activator/activator-wrapper.ts                        edit  uses claim(), MR-37
src/channel-factory.ts                                    edit  ChannelSpec.delivery?, sideEffects?
src/replicas/replica-guard.ts                             new   assessReplicaSafety, resolveReplicaSetting, errors
src/integration.module.ts                                 edit  replicas, validation, bootstrap guard, purge timer, observe
src/saga/lock-port.ts, src/saga/idempotency-ledger.ts     edit  visibility?
src/saga/saga-runner.ts                                   edit  replicas?, construction check
src/saga/postgres/advisory-lock-port.ts                   edit  visibility = 'shared'
src/testing/memory-lock-port.ts                           edit  visibility = 'process'
src/testing/idempotency-store-contract.ts                 new   idempotencyStoreContract()
test/support/shared-fake-idempotency.store.ts             new   test-only shared fake (D13)
test/idempotency-redis.e2e.spec.ts                        new   gated ESTELA_REDIS_URL
test/idempotency-postgres.e2e.spec.ts                     new   gated ESTELA_PG_URL
test/multi-replica.e2e.spec.ts                            new   two-app suite
test/docs-multi-replica.spec.ts                           new   DOC1
```

All comments English and ASCII-only (`scripts/check-comments-en.cjs`). No file below imports an npm
package; Redis and Postgres clients come from the app.

### 3.1 `src/state-visibility.ts` (new, domain, zero imports)

```ts
/** Where a port keeps its state. 'process': this Node process only. 'shared': every replica sees it. */
export type StateVisibility = 'process' | 'shared';
```

### 3.2 `src/idempotency/idempotency-store.ts` (extended)

```ts
export interface IdempotencyStore {
  begin(scope: string, key: string, ttlMs: number): Promise<boolean>;
  complete(scope: string, key: string, result: Record<string, unknown>): Promise<void>;
  fail(scope: string, key: string, error: unknown): Promise<void>;
  get(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  purgeExpired(): Promise<number>;
  release?(scope: string, key: string): Promise<void>;
  /** Undefined means unknown: the replica guard treats it as not shared. */
  readonly visibility?: StateVisibility;
  /** True when expired records stay until purgeExpired() runs (no native expiry). */
  readonly requiresPurge?: boolean;
  /** Registers a health listener (section 3.7); returns the unsubscribe function. */
  observe?(listener: IdempotencyEventListener): () => void;
}
```

### 3.3 `src/idempotency/idempotency-errors.ts` (new)

```ts
export type IdempotencyStoreOperation = 'begin' | 'complete' | 'fail' | 'get' | 'release' | 'purge';

/** Base: a store call failed. Message = code, operation and store class only (a scope can carry
 *  tenant ids, so it is a property, never message text); the driver error is in `cause`. */
export class IdempotencyStoreError extends Error {
  readonly code: string = 'IDEMPOTENCY_STORE_ERROR';
  readonly retryable: boolean = false;
  constructor(readonly operation: IdempotencyStoreOperation, readonly scope: string, readonly store: string, options?: { cause?: unknown });
}
/** The store could not be reached in time. Safe to retry the whole request later. */
export class IdempotencyStoreUnavailableError extends IdempotencyStoreError {
  readonly code = 'IDEMPOTENCY_STORE_UNAVAILABLE';
  readonly retryable = true;
}
```

Both carry a `Symbol.for('@estela/nest.IdempotencyStoreError')` brand with a `Symbol.hasInstance`
fallback, the same pattern as `ConcurrencyError`, so `instanceof` holds across the ESM and CJS bundles
(`test/dist-identity.spec.ts` gains a case). An app maps the unavailable error to HTTP 503 with
`Retry-After`, or to gRPC `UNAVAILABLE` (SPI-431 ships that mapping for `Execute`).

### 3.4 `src/idempotency/idempotency-events.ts` (new)

```ts
export type IdempotencyStoreEvent =
  | { type: 'unavailable'; store: string; operation: IdempotencyStoreOperation; errorName: string }
  | { type: 'recovered'; store: string; downForMs: number }
  | { type: 'fail-open'; scope: string }
  | { type: 'claim-lost'; store: string; scope: string; operation: 'complete' | 'fail' | 'release' }
  | { type: 'record-corrupt'; store: string; scope: string }
  | { type: 'purge-failed'; store: string; errorName: string };
export type IdempotencyEventListener = (event: IdempotencyStoreEvent) => void;
```

`store` is the store's class name. No event field carries a key, a result or an error message
(MR-16). A listener that throws is caught and logged once; it never fails the request. Origin of each
event: `unavailable`, `recovered`, `claim-lost`, `record-corrupt` come from the store; `fail-open`
from `IdempotencyService.claim` or the inbound gate; `purge-failed` from the module's purge timer.
`scope` values are logged, so the README tells applications to keep personal data out of scopes
(keys are the place for it, and keys are never logged). This is guidance, not a library check.

### 3.5 `src/idempotency/redis/redis-idempotency.store.ts` (new)

```ts
/**
 * Runs one Redis command and resolves its raw reply. Adapters:
 *   ioredis:    (args) => redis.call(args[0], ...args.slice(1))
 *   node-redis: (args) => client.sendCommand([...args])
 * Configure the client to fail fast when disconnected (ioredis: enableOfflineQueue: false),
 * otherwise operationTimeoutMs is what bounds the wait.
 */
export type RedisCommand = (args: readonly string[]) => Promise<unknown>;

export interface RedisIdempotencyStoreOptions {
  command: RedisCommand;
  keyPrefix?: string;                 // default 'estela:idem:'
  operationTimeoutMs?: number;        // default 2000 (provisional, OQ-3); integer 1..2147483647
  retainCompletedMs?: number;         // MR-21; default undefined = keep the remaining TTL
  keyDigest?: (storageKey: string) => string;   // MR-19
  /** Test seam; default crypto.randomUUID. */
  newOwnerToken?: () => string;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  readonly visibility = 'shared';
  readonly requiresPurge = false;
  constructor(options: RedisIdempotencyStoreOptions);   // validates options, throws TypeError
  begin(scope: string, key: string, ttlMs: number): Promise<boolean>;
  complete(scope: string, key: string, result: Record<string, unknown>): Promise<void>;
  fail(scope: string, key: string, error: unknown): Promise<void>;
  get(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  release(scope: string, key: string): Promise<void>;
  purgeExpired(): Promise<number>;   // always 0: Redis expires keys natively
  observe(listener: IdempotencyEventListener): () => void;
}
```

### 3.6 `src/idempotency/postgres/postgres-idempotency.store.ts` (new)

```ts
export interface PostgresIdempotencyStoreOptions {
  /** Autocommit query on a pool, NOT a transaction-bound handle (section 4.3). */
  query: SqlQuery;
  schema?: string;                    // validated with quoteIdentifier
  table?: string;                     // default 'estela_idempotency'
  purgeBatchSize?: number;            // default 1000; integer 1..100000
  operationTimeoutMs?: number;        // as Redis; a client-side race on the query promise (section 4.3)
  retainCompletedMs?: number;
  keyDigest?: (storageKey: string) => string;
  newOwnerToken?: () => string;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  readonly visibility = 'shared';
  readonly requiresPurge = true;
  constructor(options: PostgresIdempotencyStoreOptions);
  /* same five methods + release() + observe() as Redis */
  /** Deletes up to purgeBatchSize expired rows; resolves the number deleted. */
  purgeExpired(): Promise<number>;
}

/** DDL for the store table and its expiry index; idempotent (IF NOT EXISTS). Run it from the
 *  app's own migration tool. Identifiers are validated with quoteIdentifier. */
export function postgresIdempotencyMigrationSql(options?: { schema?: string; table?: string }): string;
export const POSTGRES_IDEMPOTENCY_SCHEMA_VERSION = 1;
```

`SqlQuery`, `rowsOf` and `quoteIdentifier` are reused from `src/saga/postgres/sql.ts:10,29-49`; they
move to `src/sql/sql.ts` and `src/saga/postgres/sql.ts` re-exports them unchanged, so neither layer
imports the other.

### 3.7 Store observation (`observe`, both shipped stores)

`observe(listener)` adds a listener and returns a function that removes it. Listeners are called
synchronously, in registration order, after the store call has settled its own outcome; each call is
wrapped so a throw is caught and never changes that outcome (MR-16). A store with no listener emits
nothing. The module registers one listener per distinct store at `onApplicationBootstrap` and removes
it at shutdown; an app that uses a store outside the module registers its own.

No codec hook is defined: SPI-433 seals or strips records above the store and keeps this contract
unchanged (SD-35, D17).

### 3.8 `src/idempotency/idempotency.service.ts` (extended)

```ts
export type StoreUnavailablePolicy = 'fail-closed' | 'fail-open';
export type ClaimOutcome = 'acquired' | 'duplicate' | 'bypassed';

export interface IdempotencyOptions {
  enabled?: boolean;
  ttlMs?: number;
  store?: IdempotencyStore;
  onStoreUnavailable?: StoreUnavailablePolicy;   // default 'fail-closed'
  onEvent?: IdempotencyEventListener;
  /** Channels whose scopes are always fail-closed. Filled by the module from
   *  ChannelSpec.sideEffects; an app that builds the service itself passes it. */
  sideEffectChannels?: ReadonlySet<string>;
}

export class IdempotencyService implements FlowIdempotencyPort {
  /* existing members unchanged */
  /** begin() plus the unavailability policy. 'bypassed' = fail-open: run, then do not settle. */
  claim(scope: string, key: string, ttlMs: number | undefined, at: { channel: string }): Promise<ClaimOutcome>;
  readonly visibility: StateVisibility | undefined;   // the configured store's
}
```

`begin` keeps its 0.9.0 signature and behaviour (no policy), so direct callers see no change.
The policy for a scope is: fail-closed when `at.channel` is in `sideEffectChannels`, else the
endpoint value (inbound only), else the module value, else `'fail-closed'`.

### 3.9 `src/flow/flow-executor.ts` (one optional member)

```ts
export interface FlowIdempotencyPort {
  begin(scope: string, key: string, ttlMs: number): Promise<boolean>;
  complete(scope: string, key: string, result: Record<string, unknown>): Promise<void>;
  fail(scope: string, key: string, error: unknown): Promise<void>;
  /** When present the executor uses it; 'bypassed' skips complete/fail for this run. */
  claim?(scope: string, key: string, ttlMs: number, at: { channel: string }): Promise<ClaimOutcome>;
}
```

The activator wrapper (`src/activator/activator-wrapper.ts:84-113`) uses `IdempotencyService.claim`
the same way, with `at.channel` = the activator's channel; a flow uses its source channel.

### 3.10 `src/channel-factory.ts` (extended)

```ts
export interface ChannelSpec {
  name: string;
  type: ChannelKind;
  capacity?: number;
  bindings?: readonly string[];
  /** 'best-effort': loss on crash is acceptable. 'must-not-lose': refused by the guard for every
   *  in-memory kind (durable kinds arrive with SPI-434). Undefined: undeclared. */
  delivery?: 'best-effort' | 'must-not-lose';
  /** True when a handler of this channel has external side effects (money, messages, bookings):
   *  its idempotency scopes are always fail-closed. */
  sideEffects?: boolean;
}
```

### 3.11 `src/inbound/inbound.types.ts` (extended)

`InboundIdempotencyOptions` gains `onStoreUnavailable?: StoreUnavailablePolicy` (default: the module
value). Changes in `src/inbound/inbound.idempotency.ts` (internal, not exported):
- `InboundClaim`'s `skipped` variant gains `at?: InboundStorageKey`.
- `InboundIdempotencyGate.claim` (lines 216-228) catches `IdempotencyStoreUnavailableError` from
  `begin`: fail-closed rethrows it; fail-open returns `{ status: 'skipped', at }` and emits
  `fail-open`. The interceptor (`inbound.interceptor.ts:147`) computes forwarded headers from
  `claim.at` for both `acquired` and bypassed claims (MR-14).
- `claim` catches an `IdempotencyStoreError` from the repeat `get` (line 226) and resolves the repeat
  with `record = undefined`, which `resolveRepeat` already answers as in flight (MR-37).
- `failed` checks `IdempotencyStoreError` before `decideFailureAction` and keeps the key (MR-35).

### 3.12 `src/replicas/replica-guard.ts` (new, zero npm imports)

```ts
export type ReplicaMode = 'single' | 'multi';
export interface ReplicaOptions { mode: ReplicaMode; strict?: boolean }
export type ReplicaSetting = ReplicaMode | ReplicaOptions;

export type ReplicaFindingCode =
  | 'PROCESS_LOCAL_IDEMPOTENCY_STORE' | 'UNKNOWN_STORE_VISIBILITY' | 'STORE_REF_UNRESOLVED'
  | 'IN_MEMORY_MUST_NOT_LOSE' | 'UNDECLARED_QUEUE_DELIVERY'
  | 'PROCESS_LOCAL_LOCK_PORT' | 'PROCESS_LOCAL_LEDGER'
  | 'PURGE_NOT_CONFIGURED' | 'IDEMPOTENCY_DISABLED';
export interface ReplicaFinding {
  readonly level: 'error' | 'warning' | 'info';
  readonly code: ReplicaFindingCode;
  readonly subject: string;            // e.g. "channel 'orders.work'", "module idempotency store"
  readonly message: string;            // what to change
}
export interface ReplicaSafetyInput {
  mode: ReplicaMode;
  idempotency?: { enabled: boolean; stores: readonly { subject: string; store?: Pick<IdempotencyStore, 'visibility' | 'requiresPurge'>; unresolved?: boolean }[]; purgeIntervalMs?: number };
  channels?: readonly ChannelSpec[];
  saga?: { locks?: { visibility?: StateVisibility }; ledger?: { visibility?: StateVisibility } };
}
export function assessReplicaSafety(input: ReplicaSafetyInput): ReplicaFinding[];

/** Reads option + ESTELA_REPLICAS + ESTELA_REPLICAS_STRICT (MR-22). Throws ReplicaConfigError. */
export function resolveReplicaSetting(
  option: ReplicaSetting | undefined,
  env?: Readonly<Record<string, string | undefined>>,   // default: process.env
): Required<ReplicaOptions>;

export class ReplicaConfigError extends Error {}                         // invalid option or env value
export class ReplicaSafetyError extends Error { readonly findings: readonly ReplicaFinding[] }
export const ESTELA_REPLICAS_ENV = 'ESTELA_REPLICAS';
export const ESTELA_REPLICAS_STRICT_ENV = 'ESTELA_REPLICAS_STRICT';
```

`env` is a plain record, so the declaration needs no `@types/node` and the file has no imports.
`ReplicaConfigError` has `code = 'REPLICA_CONFIG_INVALID'`; `ReplicaSafetyError` has
`code = 'REPLICA_SAFETY'`.

### 3.13 `src/integration.module.ts` (extended)

```ts
export interface IntegrationIdempotencyOptions {
  enabled?: boolean;
  ttlMs?: number;
  store?: IdempotencyStore;
  onStoreUnavailable?: StoreUnavailablePolicy;   // default 'fail-closed'
  /** Runs purgeExpired() of every distinct requiresPurge store on one unref'd timer started at
   *  bootstrap; undefined = no job. Integer 1000..2147483647 (MR-36). */
  purgeIntervalMs?: number;
  onEvent?: IdempotencyEventListener;
}
export interface IntegrationModuleOptions {
  /* existing fields */
  replicas?: ReplicaSetting;   // default 'single'
}
```

`forRoot` validates the new options synchronously (MR-36) and resolves the replica setting (MR-22).
`IntegrationRuntime` gains `onApplicationBootstrap()`: it collects the module store and every
discovered endpoint store (resolving `{ useExisting }` refs through `ModuleRef`, which only works
once every provider exists), observes each distinct store once (MR-16), runs the guard, and starts
the purge timer (MR-17). `onApplicationShutdown()` stops the timer and removes the listeners before
draining queues.

### 3.14 Saga ports (`src/saga/lock-port.ts`, `src/saga/idempotency-ledger.ts`, `src/saga/saga-runner.ts`)

`LockPort` and `IdempotencyLedger` gain `readonly visibility?: StateVisibility`;
`MemoryIdempotencyLedger` and `MemoryLockPort` set `'process'`; the object returned by
`postgresAdvisoryLockPort` sets `'shared'`. An app ledger without `visibility` is not a finding (the
saga guard only flags `'process'`), because production ledgers are app-written. `SagaRunnerOptions`
gains `replicas?: ReplicaSetting`.

### 3.15 Barrels

- `src/index.ts`: exports 3.1-3.6, 3.8 and 3.12. Safe: no npm imports.
- `src/testing/index.ts`: exports `idempotencyStoreContract` (3.16). It imports only the store port
  and the error classes, never `src/inbound/` or `src/adapters/` (dependency-cruiser rule).

### 3.16 `src/testing/idempotency-store-contract.ts` (new)

```ts
export interface StoreContractCase {
  readonly name: string;
  /** Throws an Error describing the violation. `sleep` advances real or fake time. */
  run(make: () => IdempotencyStore | Promise<IdempotencyStore>, tools: { sleep(ms: number): Promise<void> }): Promise<void>;
}
export interface StoreContractOptions {
  /** Cross-instance fencing cases (CT6). Default: true when the store declares visibility 'shared'. */
  fencing?: boolean;
  /** ttlMs validation case (CT7). Default: same as fencing. */
  validatesTtl?: boolean;
  /** fail() stores only { name, message } (CT3 strict form). Default: same as fencing. */
  serializesErrors?: boolean;
  /** Smallest TTL the backend honours reliably, a test parameter (not a product default): 200. */
  minTtlMs?: number;
}
export function idempotencyStoreContract(options?: StoreContractOptions): readonly StoreContractCase[];
```

## 4. Behaviour

### 4.1 Record model and owner fencing (both stores)

A record is `{ status, owner, result?, error? }` with an expiry on the store's clock.

- **Owner token.** `begin` generates a random token (`randomUUID`) and writes it with the record. The
  store instance keeps `storageKey -> token` in an in-process map for its own live claims. The map
  entry is removed when a settle call is applied or fenced out, or when its TTL has passed (swept on
  `begin`, by the pod clock: the sweep only bounds memory, the fencing check runs on the server). A
  settle that rejects with a store error keeps the entry, so the `fail` that inbound, flows and
  activators attempt after a failing `complete` can still apply (MR-15). The map is bounded by the
  claims in flight in this process.
- **Settle preconditions.** `complete` and `fail`: record exists, not expired, `owner` equals this
  instance's token, `status = 'in-flight'`. `release`: same owner check, `status` in
  `in-flight | failed`. When the precondition fails the call resolves (it never throws for a lost
  claim), changes nothing and emits `claim-lost`. A settle with no token in the map (the key was never
  claimed by this instance) is also a no-op with `claim-lost`.
- **Why the port signature is unchanged.** The caller that calls `complete` is the one that called
  `begin` on the same instance (`src/inbound/inbound.idempotency.ts:223-240`,
  `src/flow/flow-executor.ts:64-80`), so the token never needs to travel through the port.
- **Same-process re-claim.** If this process's own claim expires and this process claims the key again,
  the map holds the newer token and a late settle of the first run would act on the second claim.
  Accepted and documented (R4): the TTL must exceed the longest run.

### 4.2 Redis commands

| Operation | Command(s) (one round trip) | Result |
|---|---|---|
| `begin` | `SET k {"s":"in-flight","o":token} PX ttlMs NX` | `OK` -> true; nil -> false |
| `complete` | `EVAL settle 1 k token completed <json> keep-or-retainMs` | 1 -> done; 0 -> claim-lost |
| `fail` | same script, target status `failed`, `error` field | same |
| `release` | `EVAL release 1 k token` (DEL when owner matches and status is `in-flight` or `failed`) | same |
| `get` | `GET k` | absent -> undefined; parse per MR-09 |
| `purgeExpired` | none | 0 |

The stored value is one JSON document: `{"s":status,"o":owner}` plus `"r":result` (completed) or
`"e":serializeError(error)` (failed). The `settle` script reads the value, decodes it with `cjson`,
checks `o` and that `s` is `in-flight`, then `SET k <new> KEEPTTL` (or `PX retainCompletedMs`); a
value it cannot decode is left untouched and the script returns 0. The JSON of `result` is produced
in Node before the call, so MR-07 fails before any I/O. Script text is a constant; arguments are bound as `ARGV`, never spliced.
Single-key scripts are valid on Redis Cluster. Requirements on the server, documented: Redis 6.0+
(`KEEPTTL`) and `maxmemory-policy noeviction` (every Estela key has a TTL, so any `volatile-*` or
`allkeys-*` policy can evict a live claim and let a duplicate run).

### 4.3 Postgres statements

DDL (`postgresIdempotencyMigrationSql()`, default names):

```sql
CREATE TABLE IF NOT EXISTS "estela_idempotency" (
  "scope"      text        NOT NULL,
  "key"        text        NOT NULL,
  "status"     text        NOT NULL CHECK ("status" IN ('in-flight', 'completed', 'failed')),
  "owner"      text        NOT NULL,
  "result"     text,
  "error"      text,
  "expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("scope", "key")
);
CREATE INDEX IF NOT EXISTS "estela_idempotency_expires_at_idx" ON "estela_idempotency" ("expires_at");
```

`result` and `error` are `text` holding the JSON produced in Node: the store never queries inside a
record, and `text` round-trips the exact string (`jsonb` would reorder keys and costs a parse on
write). SPI-433 sealed records are ordinary JSON objects at this level (SD-35).

Statements use the table as `t` (`INSERT INTO <table> AS t`, `UPDATE <table> AS t`, and so on). TTL
arithmetic is `now() + ($4::double precision * interval '1 millisecond')`, so the parameter type is
never left to inference.

| Operation | Statement (all parameters bound) | Acquired / applied when |
|---|---|---|
| `begin` | `INSERT INTO <table> AS t (...) VALUES ($1,$2,'in-flight',$3,NULL,NULL, now() + ($4::double precision * interval '1 millisecond'), now()) ON CONFLICT (scope,key) DO UPDATE SET status='in-flight', owner=EXCLUDED.owner, result=NULL, error=NULL, expires_at=EXCLUDED.expires_at, updated_at=now() WHERE t.expires_at <= now() RETURNING 1` | one row returned |
| `complete` / `fail` | `UPDATE t SET status=$4, result|error=$5, updated_at=now() [, expires_at = now() + retain] WHERE scope=$1 AND key=$2 AND owner=$3 AND status='in-flight' AND expires_at > now() RETURNING 1` | one row |
| `release` | `DELETE FROM t WHERE scope=$1 AND key=$2 AND owner=$3 AND status IN ('in-flight','failed') RETURNING 1` | one row |
| `get` | `SELECT status, result, error FROM t WHERE scope=$1 AND key=$2 AND expires_at > now()` | |
| `purgeExpired` | `DELETE FROM t WHERE ctid = ANY(ARRAY(SELECT ctid FROM t WHERE expires_at <= now() LIMIT $1 FOR UPDATE SKIP LOCKED)) RETURNING 1` | row count |

- Results are read with `rowsOf` and counted by rows returned, never by `rowCount`
  (`src/saga/postgres/sql.ts:27-36`).
- **Autocommit.** `query` must run on a pool connection outside any transaction. Inside a long
  transaction `now()` is frozen at the transaction start and the claim would not be visible to other
  pods until COMMIT, which defeats MR-03. The store cannot detect this reliably; the README says it
  and the e2e uses a pool.
- **Timeout.** `operationTimeoutMs` races the query promise; on expiry the store rejects with
  `IdempotencyStoreUnavailableError` and ignores the late outcome. A `begin` that times out but
  commits on the server leaves a claim this instance does not know: the key stays in flight until its
  TTL, which is the fail-closed outcome. Apps should also set a server `statement_timeout` on that
  pool.
- **Unavailable vs error classification** (MR-10) reads the SQLSTATE the way `classifyPostgresError`
  does (`code`, then `driverError.code`, then `meta.code`, walking `cause` up to 5 levels;
  `src/saga/postgres/error-classifier.ts:36-59`): class `08`, `53300`, `57P01`, `57P02`, `57P03`,
  `57014` (statement timeout), `40001`, `40P01` and the Node socket codes are unavailable; everything
  else (for example `42P01`, missing table; `28P01`, bad password) is an `IdempotencyStoreError`.
  `classifyPostgresError` deliberately leaves 08xxx and 57014 unclassified because a saga retry could
  re-apply committed work. The store differs on purpose (D16): no layer of this spec retries, and a
  client retry of the whole request meets the owner-fenced, possibly committed claim, which answers
  it as in flight.

### 4.4 Unavailability policy (D-REDIS-DOWN, idempotency half)

```
claim(scope, key, ttl, { channel }):
  try acquired = await store.begin(scope, key, ttl)      // the store itself emits unavailable/recovered
  catch (e):
    if not IdempotencyStoreUnavailableError(e): throw e  // config/data errors: always closed
    policy = sideEffectChannels.has(channel) ? 'fail-closed' : resolvedPolicy(scope)
    if policy == 'fail-closed': throw e
    emit({ type: 'fail-open', scope }); return 'bypassed'
  return acquired ? 'acquired' : 'duplicate'
```

- `bypassed` runs the work and skips every settle call for that run (MR-14). A later request with the
  same key, once the store is back, finds no record and runs again: fail-open trades duplicates for
  availability, which is why side-effecting channels can never choose it.
- `get` after a `false` begin that fails with a store error is treated as in flight (MR-37): inbound
  answers per `onInFlight`, the activator sends no cached reply. Flows never call `get`. Nothing runs.
- Settle failures follow MR-15: nothing is released, nothing re-runs.
- A store error that a downstream hop raises reaches the inbound failure policy as `keep` (MR-35).
- **Which layer retries.** None defined here. The store sends one command (MR-11), the policy never
  loops, and the error carries `retryable: true` so the outermost caller decides. Under the resilience
  spec the outermost retrying layer claims the retry budget and sends `x-retry-budget: 0` downstream
  (RS-28 to RS-30), and it classifies `IdempotencyStoreUnavailableError` as transient (resilience
  spec section 5.4). Nothing here reads or writes the budget header.

### 4.5 Boot guard

Order:
1. `forRoot` (synchronous): `resolveReplicaSetting(options.replicas, process.env)`; an invalid value
   throws `ReplicaConfigError` (MR-22). The new option values (`onStoreUnavailable`,
   `purgeIntervalMs`, channel `delivery` and `sideEffects`) are validated here and an invalid one
   throws `TypeError` (MR-36). Endpoint `onStoreUnavailable` values are validated when the inbound plan
   is built, with the same `TypeError`.
2. `onModuleInit`: unchanged (channels, activators, flows, explorer).
3. `onApplicationBootstrap`: collect the module store, every discovered inbound endpoint's store
   (resolving `{ useExisting }` through `ModuleRef`), the channel specs and side-effect bindings;
   observe each distinct store once (MR-16); run `assessReplicaSafety`; check MR-13 (explicit
   fail-open on a side-effecting inbound is a `ReplicaConfigError` in every mode); log findings; in
   strict mode with errors, throw `ReplicaSafetyError`; otherwise start the purge timer when
   configured (MR-17). A thrown error rejects `app.init()`, so the pod fails its start and Kubernetes
   restarts it; the readiness probe never passes.

Findings table:

| Code | single | multi | Subject |
|---|---|---|---|
| `PROCESS_LOCAL_IDEMPOTENCY_STORE` | - | error | module store / endpoint store with `visibility: 'process'` |
| `UNKNOWN_STORE_VISIBILITY` | - | error | store without `visibility` |
| `STORE_REF_UNRESOLVED` | - | error | `{ useExisting }` that ModuleRef cannot resolve |
| `IN_MEMORY_MUST_NOT_LOSE` | warning | error | in-memory channel with `delivery: 'must-not-lose'` |
| `UNDECLARED_QUEUE_DELIVERY` | - | warning | `queue` channel without `delivery` |
| `PROCESS_LOCAL_LOCK_PORT` | - | error | `SagaRunner.locks` with `visibility: 'process'` |
| `PROCESS_LOCAL_LEDGER` | - | error | `SagaRunner.ledger` with `visibility: 'process'` |
| `PURGE_NOT_CONFIGURED` | warning | warning | store with `requiresPurge` and no `purgeIntervalMs` |
| `IDEMPOTENCY_DISABLED` | - | info | `idempotency.enabled: false` |

Log format, one line each: `estela replicas (<mode>): <level> <code> <subject>: <message>`, then one
summary line `estela replicas (<mode>): <e> error(s), <w> warning(s)` only when there are findings.
Nothing is logged in `single` with no findings (MR-27).

What the guard cannot see, documented: `TransitionPort`s (passed per call to `transition()`), stores
created inside activators, state an application keeps itself, and stores used by a `SagaRunner` or
service built outside the module. OQ-5 tracks the transition port.

### 4.6 Request/reply in a multi-replica deployment

- The inbound request lands in one pod; `ReplyGateway` registers `reply.<uuid>` there; every hop
  (`direct`, `queue`, `pubsub`, `fanout`, activators, `jump`) runs in that pod; the reply arrives
  there. This holds for any replica count because channels are in-process.
- A hop that leaves the process without answering in the same hop (Rabbit outbound,
  `bindRabbitOutbound`; `bindGrpcOut`, which replies only to its fixed `options.replyChannel`,
  `src/adapters/grpc.adapter.ts:12-31`) does not carry `replyChannel` (MR-30). If the remote side is
  expected to answer through the channel, the waiter ends with `ReplyTimeoutError`; whatever the
  inbound `onFailure` says, that error is kept, never released (`src/inbound/inbound.failure.ts:152`,
  `README.md:270`), so a client retry is answered as in flight until the TTL.
- The supported way to call another service inside request/reply is a call that returns its answer in
  the same hop: an outbound REST binding (it replies on the message's `replyChannel` in the calling
  pod, `src/outbound/outbound.types.ts:348-353`), and outbound gRPC request/reply once SPI-430 ships
  it.
- Cross-pod reply (a waiter in pod A answered from pod B) is SPI-434.

## 5. Invariants (each has a test)

- **I1. One winner per live claim.** For a live `(scope, key)` at most one `begin` resolves true
  across all processes sharing the store (MR-03; RE1, PE2, CT1, E2).
- **I2. A fenced-out settle changes nothing.** A process that lost its claim cannot overwrite,
  fail or delete the current owner's record (MR-04; RU3, PU3, E5).
- **I3. Store failure never multiplies work.** No path re-runs work or releases a key because the
  store failed; only an explicit fail-open on a non-side-effecting scope runs work without a claim
  (MR-12, MR-13, MR-15, MR-35; SU1-SU6, SU9).
- **I4. Unknown is in flight.** An unreadable record, a `get` that fails after a refused `begin`, and a
  timed-out `begin` are all treated as in flight, never as free (MR-09, MR-37; RU7, PU7, SU10, RU9).
- **I5. Store time only.** Expiry is computed with the store's clock (Redis `PX`, Postgres `now()`),
  never the pod clock, so clock skew between pods cannot shorten or extend a claim (MR-05).
- **I6. No data in logs or events.** Store logs, events and error messages carry scope, operation,
  store class and error class only (MR-16; SU7, RU8).
- **I7. replyChannel never leaves the process** (MR-30; HU1).
- **I8. Default is unchanged.** Without `replicas`/`ESTELA_REPLICAS`, 0.9.0 behaviour and logs are
  preserved (MR-27; GU7 plus the untouched existing suites).

## 6. Failure and interaction matrix

### 6.1 Store failures

| Phase | Failure | fail-closed (default, and always for `sideEffects`) | fail-open (non-side-effecting only) |
|---|---|---|---|
| config | invalid `ESTELA_REPLICAS(_STRICT)` / option | `ReplicaConfigError` from `forRoot` | same |
| config | explicit fail-open on a side-effecting inbound | `ReplicaConfigError` at bootstrap | n/a |
| config | invalid new option value (`purgeIntervalMs`, `onStoreUnavailable`, `delivery`, `sideEffects`, store options) | `TypeError` from `forRoot` or the store constructor (MR-36) | same |
| `begin` | unavailable (MR-10 list, or `operationTimeoutMs` exceeded) | `IdempotencyStoreUnavailableError`; nothing dispatched; on a `queue`/`pubsub`/`fanout` source the message goes to the error channel and is not redelivered | run without claim, `fail-open` event, no settle; the key is still forwarded downstream (MR-14) |
| `begin` | `keyDigest` throws or returns a non-string | `IdempotencyStoreError` before any I/O; nothing dispatched | same (not an unavailability) |
| `begin` | other error (missing table, auth, bad script) | `IdempotencyStoreError`; nothing dispatched | same (fail-open applies to unavailability only) |
| `begin` | times out but committed on the server | rejected as unavailable; key stays in flight until TTL | runs once without claim; the key then stays in flight until TTL (a retry is a duplicate) |
| `get` after `begin=false` | any `IdempotencyStoreError` | inbound: treated as in flight (`onInFlight`); activator: no cached reply, method not invoked (MR-37) | same |
| `complete` | unavailable / error | inbound: `fail` attempted, request rejects; flow/activator: `fail` attempted, error channel, rethrow (no reply sent); key `failed` if that `fail` applied, else in flight until TTL; no release (MR-15) | n/a (bypassed runs never settle) |
| downstream store error reaches inbound `failed()` | any `IdempotencyStoreError` | settled as `keep` whatever `onFailure` says (MR-35) | n/a |
| `complete` | claim lost (TTL passed, re-claimed elsewhere) | resolves; `claim-lost`; the other owner's record stands | n/a |
| `complete` | result not serializable | `IdempotencyStoreError` before any I/O; the store leaves the record in flight; the caller's `fail` then marks it `failed` | n/a |
| `fail` | unavailable | swallowed as in 0.9.0 (`.catch(() => undefined)`); key in flight until TTL | n/a |
| `release` (`onFailure: 'release'`) | unavailable | the policy error is swallowed (0.9.0 `failed()` semantics), falls back to `fail`, which also fails silently: key in flight until TTL | n/a |
| `release` | claim lost | no-op, `claim-lost` | n/a |
| read | corrupt value / unknown status | in flight, `record-corrupt` | same |
| purge job | any | `purge-failed` event; timer keeps running | same |
| `onEvent` / `observe` listener | throws | caught, logged once per listener; call outcome unchanged | same |
| Redis evicts a live claim (`maxmemory-policy` not `noeviction`) | key vanishes | a repeat runs again (R2); settle of the evicted claim is fenced out (`claim-lost`) | same |

### 6.2 Interactions with existing options

| Combination | Behaviour |
|---|---|
| `onDuplicate: 'replay'` + shared store | Replay reads `result.cachedResult` from the shared record, so pod B replays pod A's answer. The reply mapper runs in pod B. The value has been through JSON: a `Date` replays as an ISO string, `undefined` members and `Map`/`Set` contents are lost, class instances replay as plain objects. The memory store replays the original object, so a handler that relies on such types behaves differently once a shared store is configured; documented next to the option. SPI-433 `status-only` and `encrypted` records are handled above the store (SD-30, SD-35). |
| `onDuplicate: 'replay'` + fail-open bypass | Nothing was stored, so a later repeat runs again: replay is impossible for bypassed runs. Documented next to the option. |
| `onInFlight: 'reject'` + store unavailable on the follow-up `get` | Rejects with `InboundIdempotencyInFlightError` (I4). |
| `onFailure: 'store'` + shared store | The failure is serialized by the inbound `failureCodec` and stored through `complete`; any pod replays it. |
| `onFailure: 'release'` + Postgres/Redis store | Supported (`release()` shipped); owner-fenced. |
| Inbound `forward: 'raw'` + flow scope | Two claims per request (inbound and `flow:<name>`), each subject to the policy; with fail-closed either can reject. |
| Inbound fail-open + downstream `sideEffects` channel | The inbound bypass still forwards the key (MR-14); the downstream claim on the side-effecting channel fails closed and the request fails with the retryable error. With `forward: 'none'` (forced when an `onFailure` policy is set, `inbound.plan.ts:185-192`) no downstream claim exists: the review skill flags fail-open + `forward: 'none'` in front of side effects (R7). |
| Estela outbound REST caller receives the 503 an app maps from `IdempotencyStoreUnavailableError` | The caller's default `retryOn` retries 408, 429 and 5xx (`outbound.plan.ts:227`) for repeatable calls, so callers retry. That is the outermost layer retrying, the intended place; the budget that bounds it is the resilience spec's (RS-28 to RS-30). |
| Fire-and-forget inbound into a `queue` channel | The key is completed when the message is buffered (`inbound.interceptor.ts:166`); a crash loses the work and blocks the retry until the TTL. The guard warns on undeclared queues in multi; `must-not-lose` is refused until SPI-434. |
| `idempotency.enabled: false` | `NoopIdempotencyStore`; guard info only; no unavailability path exists. |
| Saga ledger vs idempotency store | Independent. A saga keeps its app-written transactional ledger; this spec only adds `visibility` so the guard sees `MemoryIdempotencyLedger`. |
| `keyDigest` + `forward: 'resolved'` | The digest applies only inside the store; the forwarded header still carries the resolved key. Redacting that header in sinks is SPI-433 (SD-09). |
| Same key, two pods, concurrent (no failure) | One `acquired`, the other `duplicate` (in flight) answered per `onInFlight` (E2). |

## 7. Non-functional requirements

- **Dependencies.** Zero new runtime dependencies. `ioredis` (exact version) is added as a
  devDependency for the gated e2e only. New dependency-cruiser rules: `idempotency-stores-no-npm`
  (`src/idempotency/redis/`, `src/idempotency/postgres/`, `src/replicas/` import no npm package) and
  `src-no-redis` (`src/` never imports `ioredis`, `redis`, `@redis/*`).
- **Security.** All Redis arguments and SQL parameters are bound, never interpolated; identifiers go
  through `quoteIdentifier`. Error messages carry code, operation and store class only (driver text,
  which can name tables or echo values, stays in `cause`; scope is a property). Stored data threat
  model:
  - In scope for this spec: what the store persists (`result`, `error`, the key) and what Estela logs
    about it. Floor: `serializeError` only (MR-08), no keys or values in logs (MR-16), optional
    `keyDigest` (MR-19). Sealing or stripping `result` (`storeMode`) and redaction of the other
    sinks (hop logs, history, wire-tap, saga ledger, test captures) are SPI-433.
  - Scopes are logged. They are meant to be names (`flow:orders`, `org:<id>`); the README states that
    personal data goes in keys, never in scopes.
  - Out of scope: Redis/Postgres server-side persistence and backups, heap dumps, APM exporters, Nest's
    own exception logs. Guidance in the README: encrypt at rest, restrict the Redis ACL to the key
    prefix, do not log `cause` in exception filters.
  - `keyDigest` guidance (README, not enforceable by the library): a plain hash of a low-entropy key
    (a phone number, an order number) is brute-forced offline, so use a keyed HMAC with a secret of at
    least 32 bytes and keep the full output (truncation raises the collision rate, and a collision
    makes two different requests share one claim). Rotating the secret changes every storage key:
    every live claim and completed record becomes invisible, so for one TTL window repeats run again.
    Rotate only with a drain, or accept that window. Owner default D-PHONE (customer numbers hashed
    with a salted HMAC in sinks) is applied by adopters through this hook; the library default stores
    keys verbatim because it cannot know which keys hold phone numbers.
- **Performance.** Each claim adds one store round trip for `begin` and one for the settle (two on a
  repeat: `begin` and `get`). No budget is set here; SPI-444 measures overhead per hop for the memory,
  Redis and Postgres stores and fixes `operationTimeoutMs` (OQ-3).
- **Operability.** One warn line per availability transition; `onEvent` for metrics. Postgres table
  growth is bounded by `purgeIntervalMs`. A boot that fails strict mode names every error finding in
  one exception, so one failed rollout shows the whole list.
- **Compatibility.** Node >= 18 (`crypto.randomUUID`), Nest 10 and 11 peers unchanged, Redis >= 6.0,
  Postgres >= 11. Declarations parse on TS 4.9.
- **Language.** Code, comments and docs English only (AGENTS.md).

## 8. Test plan

Test ids (`RU1`, `RE1`, `PU1`, ...) are local to this spec. The resilience spec uses its own ids
(`RU-01`, `RE-01`); outside this file cite these as `MR:RU1`.

### 8.1 Unit tests (no network)

**Redis store** (`src/idempotency/redis/redis-idempotency.store.spec.ts`, scripted fake `RedisCommand`
that records arguments and returns canned replies)
- **RU1.** Commands per operation match section 4.2; `keyPrefix` default and custom; arguments contain
  no interpolated script text.
- **RU2.** `begin` maps `OK` to true and nil to false; `purgeExpired` sends nothing and resolves 0.
- **RU3.** Fencing: a settle with no token, with a stale token (script returns 0) and on a completed
  record are no-ops that emit `claim-lost` and resolve.
- **RU4.** `ttlMs` 0, 1.5, `NaN`, 2^31 -> `TypeError`, zero commands.
- **RU5.** BigInt and cyclic results -> `IdempotencyStoreError`, `retryable: false`.
- **RU6.** `fail` stores `{ name, message }` only for an Error with stack, cause and extra fields;
  `{ value }` for a string.
- **RU7.** `not-json`, `{"s":"weird"}` and an empty string read as in flight with `record-corrupt`.
- **RU8.** `ECONNREFUSED`, `ECONNRESET`, `LOADING`, `READONLY`, `CLUSTERDOWN`, `TRYAGAIN` ->
  unavailable; `NOSCRIPT`, `WRONGTYPE`, `NOAUTH` -> `IdempotencyStoreError`; `message` has no driver
  text; `cause` is the original error.
- **RU9.** A command that never settles -> unavailable after `operationTimeoutMs` (fake timers); a late
  resolution is ignored.
- **RU10.** One failing call -> exactly one command sent (no retry).
- **RU11.** `keyDigest` output is the only key material in any argument; a throwing digest and one
  returning `''` reject with `IdempotencyStoreError` and send nothing.
- **RU12.** Events: 100 transient failures then one success emit exactly one `unavailable` and one
  `recovered` to every `observe` listener; a removed listener receives nothing; a throwing listener
  does not change the call outcome; no event field contains the key.
- **RU13.** Constructor validation: missing `command`, `operationTimeoutMs` 0 / 1.5 / 2^31, non-string
  `keyPrefix` -> `TypeError`.

**Postgres store** (`src/idempotency/postgres/postgres-idempotency.store.spec.ts`, fake `SqlQuery`)
- **PU1.** Statements per operation match section 4.3; schema/table quoting; a hostile identifier
  throws `TypeError` at construction; migration SQL snapshot.
- **PU3-PU11.** Postgres counterparts of RU3-RU12 (fencing by `RETURNING` row count, TTL validation,
  serialization, `serializeError` floor, corrupt rows, SQLSTATE classification table including the
  `driverError`/`meta`/`cause` chain and 57014/40001/40P01, no retry, `keyDigest`, events). PU2 is
  intentionally unused.

**Service and call sites** (existing files extended: `src/idempotency/idempotency.spec.ts`,
`src/inbound/inbound.spec.ts`, `src/flow/flow-executor.spec.ts`, `src/activator/activator.spec.ts`;
store stub with injectable failures)
- **SU1.** Inbound fail-closed: unavailable `begin` -> error rethrown, registry `send` never called.
- **SU2.** Flow fail-closed: steps never run, error rethrown.
- **SU3.** Activator fail-closed: method never invoked, error rethrown.
- **SU4.** Module default fail-open + `sideEffects: true` channel -> fail-closed for that scope, one
  boot info line.
- **SU5.** Fail-open: handler runs once, zero settle calls, one `fail-open` event; inbound claim is
  `skipped` with `at`; with `forward: 'resolved'` the dispatched message carries the resolved key.
- **SU6.** `complete` unavailable after success, for inbound, flow and activator: no `release`; with
  `fail` also unavailable the next request is answered as in flight; with `fail` available it is
  answered as a failed duplicate; in both cases nothing is dispatched.
- **SU7.** Module wiring: a store emitting 100 `unavailable`-path failures then one success produces
  exactly one warn line for each transition and forwards both events to `idempotency.onEvent`; an
  endpoint store is observed too; no line contains the key; listeners are removed on shutdown.
- **SU8.** Purge timer: fires on fake timers, unref'd, cleared on shutdown, a throwing purge emits
  `purge-failed` and the timer keeps going; with a module store and a distinct endpoint store, both
  are purged.
- **SU9.** An inbound whose `onFailure` releases every error, a downstream activator whose
  `complete` rejects with `IdempotencyStoreUnavailableError`: `release` is never called on the inbound
  key (MR-35).
- **SU10.** `begin` false then `get` rejecting with `IdempotencyStoreUnavailableError`: inbound with
  `onInFlight: 'reject'` throws `InboundIdempotencyInFlightError`, with `'duplicate'` answers the
  in-flight duplicate; activator sends no reply and does not invoke the method; a plain `Error` from
  `get` still propagates (MR-37).

**Guard** (`src/replicas/replica-guard.spec.ts`)
- **GU1.** `visibility` of every built-in port (MR-34); `assessReplicaSafety` purity.
- **GU2.** Env parsing: accepted values, invalid values throw `ReplicaConfigError`, "multi wins",
  "strict wins", option object and string forms, empty string and whitespace-only treated as unset,
  `MULTI` rejected (case-sensitive).
- **GU3.** Store findings: memory store, undeclared store, unresolved ref, shared store (none).
- **GU4.** Delivery matrix of MR-24 in both modes, including a `direct` channel with `must-not-lose`.
- **GU5.** `SagaRunner` with `MemoryLockPort` / `MemoryIdempotencyLedger` in multi: logged; strict:
  throws `ReplicaSafetyError` with the code; `postgresAdvisoryLockPort`: no finding.
- **GU6.** Strict with 2 errors + 1 warning: one `ReplicaSafetyError` with both errors; warning logged.
- **GU7.** Single mode, example app options: zero findings, zero log lines.
- **GU8.** Explicit fail-open on a side-effecting inbound: `ReplicaConfigError` in single and multi.
- **GU9.** `requiresPurge` without `purgeIntervalMs`: warning.
- **GU10.** `forRoot` validation (MR-36): `purgeIntervalMs` 10 and 1.5, `onStoreUnavailable: 'open'`,
  `delivery: 'durable'`, `sideEffects: 'yes'` each throw `TypeError` naming the option; an endpoint
  `onStoreUnavailable: 'open'` throws when the plan is built.

**Header mappers** (`src/adapters/header-mapper.spec.ts`, new: the adapters folder has no spec today)
- **HU1.** HTTP, gRPC, AMQP and GraphQL `mapOut` never emit `replyChannel` or a `reply.` value.

**Boundaries and build**
- **BND1.** dependency-cruiser rules `idempotency-stores-no-npm` and `src-no-redis` pass; a fixture
  import of `ioredis` from `src/` fails them.
- **DI1.** `test/dist-identity.spec.ts` gains a case: `IdempotencyStoreUnavailableError` from the
  testing bundle passes `instanceof` against the main bundle class (MR-38).
- **DOC1.** `test/docs-multi-replica.spec.ts` reads `README.md` and `skills/estela-setup/SKILL.md`
  and asserts each contains a "Multiple replicas" heading, the single-pod request/reply rule and
  `ReplyTimeoutError` (MR-31).

**Contract** (`src/testing/idempotency-store-contract.spec.ts`, run against the memory store with
`fencing`, `validatesTtl` and `serializesErrors` false; the gated e2e runs it against Redis and
Postgres with all three true)
- **CT1** begin then begin -> true, false. **CT2** complete then get -> completed with the result.
  **CT3** fail then get -> `failed` (with `serializesErrors`: exactly `{ name, message }`). **CT4** TTL expiry frees the key.
  **CT5** release frees the key. **CT6** two instances, stale settle is fenced (fencing only).
  **CT7** ttl validation. **CT8** `get` of an absent key -> undefined.

### 8.2 Integration and e2e

**`test/idempotency-redis.e2e.spec.ts`** (skipped unless `ESTELA_REDIS_URL`; key prefix per run, keys
deleted at the end, so parallel runs can share a server)
- **RE1.** 50 concurrent `begin` from two store instances -> exactly one true.
- **RE2.** TTL expiry and `KEEPTTL` after `complete`.
- **RE3.** `retainCompletedMs`.
- Contract CT1-CT8 against the real server.

**`test/idempotency-postgres.e2e.spec.ts`** (skipped unless `ESTELA_PG_URL`; throwaway schema per run,
as `test/saga-postgres.e2e.spec.ts`)
- **PE1.** Migration applies twice (idempotent); round trip of every operation.
- **PE2.** 50 concurrent `begin` from two pools -> exactly one row returned.
- **PE3.** Expired row is re-claimable by `begin` (the `DO UPDATE ... WHERE expires_at <= now()` path).
- **PE4.** `retainCompletedMs`.
- **PE5.** Purge batches (1000, 1000, 500) and two concurrent purgers delete each row once
  (`SKIP LOCKED`).
- Contract CT1-CT8 against the real server.

**`test/multi-replica.e2e.spec.ts`: two-instance design**

Two Nest applications are created in one Jest process (`Test.createTestingModule` twice), each with
its own `IntegrationModule.forRoot({ replicas: { mode: 'multi', strict: true }, idempotency: { store } })`,
each listening on its own loopback port, so requests really go through HTTP like two pods behind a
load balancer. Both apps declare the same controller:
`@InboundRest({ channel: 'work', requestReply: true, idempotency: { onDuplicate: 'replay', onInFlight: 'reject', onFailure: classify } })`
and an activator on `work` that increments a counter shared by the test (the "side effect"), can be
told to wait on a latch, and can be told to fail.

The suite is parameterized over the store backing both apps:
- `shared-fake`: one `SharedFakeIdempotencyStore` instance from `test/support/` (owner-fenced,
  `visibility: 'shared'`, injectable faults). Always runs. It lives in `test/`, never in
  `src/testing/`, so no shipped class can claim `'shared'` without being shared.
- `redis`: two `RedisIdempotencyStore` instances, two ioredis clients (gated `ESTELA_REDIS_URL`).
- `postgres`: two `PostgresIdempotencyStore` instances, two `pg` pools (gated `ESTELA_PG_URL`).

Cases:
- **E1. Sequential duplicate across pods.** Key `k1` to A, then to B -> counter 1; B answers the
  replayed reply of A.
- **E2. Concurrent duplicate.** `k2` to A and B at once while the activator waits on a latch -> counter
  1; the loser gets HTTP 409 (the test's exception filter maps `InboundIdempotencyInFlightError`,
  code `IDEMPOTENCY_KEY_IN_PROGRESS`; Estela itself does not map it, `inbound.failure.ts:46`); after
  the latch opens, a third request replays.
- **E3. Release across pods.** A's activator fails with a release-classified error -> B's retry with
  the same key runs (counter 2 attempts, 1 success).
- **E4. Store unavailable.** Fault injected (fake), Redis paused with `CLIENT PAUSE`, Postgres pool
  pointed at a closed port -> both apps answer 503 (test exception filter maps
  `IdempotencyStoreUnavailableError`), counter unchanged; after recovery the same key runs once.
- **E5. Lease expiry and fencing.** `ttlMs` 300, A's activator waits 600 ms; B claims `k5` at 400 ms
  and completes; A then completes -> B's record stands, one `claim-lost` event in A, counter 2 (the
  documented cost of a TTL shorter than the run).
- **E6. Boot guard.** A third app with the memory store and `strict` fails `init()` with
  `ReplicaSafetyError` (`PROCESS_LOCAL_IDEMPOTENCY_STORE`); the same app non-strict boots and logs the
  finding.
- **E7. Request/reply stays local.** A `requestReply` call to A whose flow runs entirely in A replies.
  A second endpoint in A (`timeoutMs: 300`) routes to a channel bound with `bindRabbitOutbound` to a
  fake `AmqpLikeChannel` shared by both apps; B consumes it through `rabbitMappings` and its activator
  returns a value. B's activator runs once, no reply reaches A, and A answers with the reply timeout;
  a repeat with the same key is answered as in flight (the timeout is kept). Documents MR-31 as
  executable behaviour.

## 9. Documentation to update (same PR)

- **README.**
  - New section "Multiple replicas": the guard, `ESTELA_REPLICAS` / `ESTELA_REPLICAS_STRICT`, the
    findings table, the request/reply single-pod rule (MR-31), `delivery` and `sideEffects`, the
    rolling-update overlap (R11), and "durable channels: planned".
  - "Tracing & idempotency": replace the Redis snippet (`README.md:155-173`) with the shipped stores,
    the client adapters (ioredis, node-redis, TypeORM, pg, Prisma), Redis 6.0+ and `noeviction`,
    Postgres autocommit and purge, `onStoreUnavailable`, `observe` and events, `keyDigest` and
    rotation, "no personal data in scopes", the migration notes of section 1.4.
  - "Idempotency options": add `onStoreUnavailable`; caveats for fail-open with `replay`, for
    fail-open with `forward: 'none'`, for fire-and-forget into a queue, and for the JSON round trip of
    replayed values with a shared store.
  - "Testing": `idempotencyStoreContract`; the Status table gets the new env-gated suites.
- **AGENTS.md.**
  - Commands: `ESTELA_REDIS_URL` gated suite and its local target
    (`ESTELA_REDIS_URL=redis://localhost:56379 npx jest test/idempotency-redis test/multi-replica`),
    and the Postgres store suite under `ESTELA_PG_URL`.
  - Layer boundaries: `idempotency-stores-no-npm`, `src-no-redis`, `src/sql/` shared helpers.
  - Adding features: "New idempotency backend -> implement `IdempotencyStore`, declare `visibility`
    (and `requiresPurge`), pass `idempotencyStoreContract()`"; "new process-local port -> declare
    `visibility: 'process'`".
  - Breaking-change list: `IdempotencyStore`, `LockPort`, `IdempotencyLedger` gained optional members
    (additive).
- **skills/.**
  - `estela-setup`: wiring both stores, the guard, env variables, the single-pod request/reply rule.
  - `estela-testing`: the contract suite, the shared fake pattern for two-app tests.
  - `estela-review` checklist: no memory store with replicas > 1; every `queue` declares `delivery`;
    side-effecting channels marked `sideEffects: true`; no fail-open on money or messaging paths; no
    fail-open endpoint with `forward: 'none'` in front of side effects; TTL longer than the longest
    run; Redis `noeviction`.
  - `estela-flows`: `delivery` and `sideEffects` on channel specs.
- **CHANGELOG.** Produced by semantic-release from the `feat` commit; `package.json` is not edited.

## 10. Dependencies on other tickets

```
SPI-429 (this)  -- IdempotencyStoreUnavailableError -->  SPI-431 Execute maps it to gRPC UNAVAILABLE
                                                          (in-flight to ABORTED); soft, by name
SPI-429         -- shipped stores, D-REDIS-DOWN ------>  SPI-RES resilience: classifies the error as
                                                          transient, owns the retry budget (soft)
SPI-433         -- seals records above the store ---->  independent of SPI-429; SD-35 contract test
                                                          is reused against both shipped stores
SPI-429         -- delivery / visibility / codes ---->  SPI-434 durable channels, cross-pod reply
SPI-429         -- overheads, operationTimeoutMs ---->  SPI-444 benchmarks (sets the defaults)
SPI-429         -- a shared store, optional --------->  SPI-441 scheduler single-run (may reuse it)
SPI-429         -- guard + stores ------------------->  Koletz adoption (KA-01..KA-10): adopters
                                                          enable the guard before scaling
```

SPI-429 has no blocking dependency; its place in the release plan is the agreed order below. The
arrows above are consumers of SPI-429; none of them blocks it. SPI-430, SPI-432, SPI-435 to
SPI-440, SPI-442 and SPI-443 neither block nor consume it. SPI-435 (BullMQ) and SPI-434 are the
routes for must-not-lose work.

### Agreed delivery order (identical in the four SPI-428 specs)

1. **SPI-433 sensitive data (P0)** ships first. With SPI-432 (graph control, P0) it gates the first
   Koletz adoption step (A1).
2. **SPI-429 multi-replica (P1).** Its boot guard is released and enabled in Koletz (KA-01, KA-02)
   before any service runs more than one replica or an HPA; until then the Koletz CI check KA-03
   blocks scaling. It does not gate A1.
3. **SPI-RES resilience** after SPI-429, so RS-50 lands with the guard instead of as a follow-up;
   SPI-430 and SPI-436 merge after it or rebase onto it.
4. **Koletz adoption (KA-)**, gated by the P0 items: A1 by SPI-433 + SPI-432; A4 by SPI-433 +
   SPI-431; A3 by SPI-RES (plus SPI-430 / SPI-436 for gRPC and SDK hops); A7 (shared store, scaling
   allowed) by the SPI-429 stores.

The build-time dependencies between the three library tickets stay soft (none blocks another); the
order above is the release plan, not a code dependency.

## 11. Risks (accepted, documented)

- **R1. Redis failover can lose a claim.** Redis replication is asynchronous: a `SET NX` acknowledged
  by a primary that fails before replicating is lost, and a duplicate can run. For money paths prefer
  the Postgres store, or accept the window. Which store an adopter uses for which path is decided
  in the adoption spec.
- **R2. Eviction.** A Redis with an evicting `maxmemory-policy` silently drops live claims. The store
  cannot check it on managed Redis (CONFIG disabled); documentation only.
- **R3. TTL shorter than the run.** A claim that expires before its run ends lets another pod run the
  same key; fencing keeps the record consistent but cannot undo the duplicate side effect (E5).
- **R4. Same-process re-claim** (section 4.1): a late settle of an expired run in the same process acts
  on the new claim. Same mitigation as R3.
- **R5. Fail-open duplicates.** By definition; refused for side-effecting channels.
- **R6. Guard blind spots.** Transition ports, stores built inside activators, stores used outside the
  module and app-owned state are invisible to the guard (OQ-5).
- **R7. `sideEffects` is declarative.** A side-effecting channel that is not marked can be configured
  fail-open, and a fail-open inbound with `forward: 'none'` leaves the downstream hops without a key.
  The review skill checks both; Estela cannot infer side effects.
- **R8. Postgres store inside a transaction.** A transaction-bound query function breaks cross-pod
  visibility (section 4.3); documented, not detectable.
- **R9. Clock.** Postgres `now()` and Redis expiry are server clocks; a Redis cluster with skewed nodes
  only affects keys on the skewed node. Pods' clocks never matter (I5).
- **R10. In-memory queues stay lossy** until SPI-434; the guard makes the loss explicit, it does not
  remove it. Fail-closed on a `queue`/`pubsub`/`fanout`-fed hop drops that message to the error
  channel (no redelivery), which is the visible form of the same limit.
- **R11. Rolling-update overlap.** A one-replica Deployment runs two pods during each rollout. With the
  memory store, repeats that cross the two pods in that window run twice; this exists in 0.9.0 and
  is removed only by a shared store. With a shared store in place, setting `multi` keeps the guard on
  during rollouts.
- **R12. Store outage blocks keys for a TTL.** A `complete` or `fail` that cannot reach the store
  leaves the key in flight until its TTL (I3 over availability); with the 0.9.0 default TTL of one
  hour a client cannot repeat that key for up to an hour. Adopters size `ttlMs` per scope.
- **R13. JSON round trip of replays** (section 6.2): handlers that return `Date`, `Map` or class
  instances replay a different shape from a shared store than from the memory store.

## 12. Decisions log

| # | Question | Decision | Reason |
|---|---|---|---|
| D1 | How does the Redis store talk to the client | One `RedisCommand` function (`args -> reply`) | Same shape for ioredis and node-redis; zero npm imports; mirrors `SqlQuery`. |
| D2 | Ownership check without changing the port | Owner token written with the claim, kept in an in-process map of the instance | The settling caller is always the claiming instance; the port stays source-compatible. |
| D3 | Whose clock defines TTL | The store's (Redis `PX`, Postgres `now()`) | Pod clock skew must not shorten claims. |
| D4 | TTL after `complete` | Keep the remaining TTL (0.9.0 parity with the memory store and the README snippet); `retainCompletedMs` opt-in | No silent change in how long repeats are recognised. |
| D5 | Corrupt record | In flight | Never re-run work on doubt. |
| D6 | Stores retry? | Never; one command per call | Retry amplification belongs to one layer, the outermost caller. |
| D-REDIS-DOWN | Store unavailable | Fail-closed by default; side-effecting channels always fail-closed; fail-open configurable elsewhere. Rate limiter/breaker degradation to local state is in the resilience spec. | Owner default 2026-11-09; owner may override (OQ-1). |
| D7 | How to mark side-effecting | `ChannelSpec.sideEffects` | The channel is the unit that flows, activators and inbound share. |
| D8 | Mode precedence between code and env | `multi` wins; strict wins | Ops can force the guard without a code change; code cannot silently disable it (OQ-4). |
| D9 | Guard failure in non-strict mode | Log only | Lets adopters see findings before enforcing. |
| D10 | Where the guard runs | `forRoot` for config validation, `onApplicationBootstrap` for findings | `{ useExisting }` refs only resolve after all providers exist. |
| D11 | Saga ports | `SagaRunner` runs the same check itself | It is built by the app, outside the module. |
| D12 | Request/reply across pods | Not supported; documented and locked by MR-30 | Distributed reply needs broker-backed channels (SPI-434). The previous draft's boot refusal of broker-crossing paths depended on SPI-434 and is dropped. |
| D13 | Shared fake in `src/testing/` | No: in `test/support/` only | A shipped class declaring `'shared'` would let apps pass the guard with process-local state. |
| D14 | Postgres `result` column type | `text` holding JSON | Byte-exact round trip; the store never queries inside a record; no `jsonb` parse on write. |
| D-PHONE | Customer phone numbers in stored keys | Library default: keys stored verbatim; `keyDigest` (keyed HMAC) available. Applying the owner default (customer numbers `hash`, business/sender numbers may be `partial`) to phone-bearing keys is an adopter decision recorded in the Koletz adoption spec. | Owner default 2026-11-09: customer phones are hashed (HMAC, salted) in sinks; the store is a sink, but the library cannot tell which keys hold phones, and key hashing has a rotation cost (section 7). Owner may override (OQ-2). |
| D15 | How store health reaches logs and metrics | Stores emit through `observe`; the module observes every distinct store at bootstrap and logs and forwards | Stores have zero npm imports, so they cannot use Nest's `Logger`; one path covers module and endpoint stores. |
| D16 | Postgres classes 08, 57014 vs `classifyPostgresError` | Unavailable (retryable) in the store, still unclassified for sagas | No layer here retries; a client retry meets the fenced, possibly committed claim and is answered as in flight. A saga retry could re-apply work, hence the saga classifier stays as it is. |
| D17 | Record codec hook (previous draft MR-20) | Dropped; MR-20 retired | SPI-433 seals records above the store and keeps the store contract unchanged (SD-35); a second hook would be speculative and would clash with SPI-433's own `RecordCodec` name. |
| D18 | Store errors reaching the inbound failure policy | Always `keep` (MR-35) | The inbound cannot know whether downstream work ran; same reasoning as the existing `ReplyTimeoutError` rule (`inbound.failure.ts:152`). |

## 13. Open questions

| # | Question | Default taken | Owner |
|---|---|---|---|
| OQ-1 | D-REDIS-DOWN: keep fail-closed as the default for non-side-effecting scopes? | Yes | Platform owner |
| OQ-2 | D-PHONE: keep "keys verbatim by default, `keyDigest` opt-in" in the library, leaving hashing of phone-bearing keys to adopters? | Yes | Platform owner |
| OQ-3 | `operationTimeoutMs` default (2000 ms provisional) | Provisional until SPI-444 measures | ESTELA maintainer |
| OQ-4 | Should an explicit code `'single'` be allowed to override env `multi`? | No ("multi wins") | ESTELA maintainer |
| OQ-5 | Should `transition()` check its `TransitionPort.visibility` against the replica mode? | Not in SPI-429 | ESTELA maintainer |
| OQ-6 | (moved) Which store adopters use for money paths is an adoption-spec question; see R1 for the library guidance | n/a | Koletz platform owner, in the adoption spec |
| OQ-7 | Default for `retainCompletedMs` | Undefined (keep remaining TTL) | ESTELA maintainer |
| OQ-8 | Update SPI-429 in Jira: priority P0 to P1 (premise, section 0.2) and title "cross-replica idempotency stores + request/reply" to "... + boot guard; request/reply stays local" (cross-pod reply moved to SPI-434) | Update both | Platform owner |
| OQ-9 | Should endpoint stores built outside `forRoot` (and a `SagaRunner`'s stores) be registrable with the guard? | No (R6) | ESTELA maintainer |

## 14. Definition of done

- Every MUST requirement has its named test passing; every SHOULD is implemented or listed in the PR
  "What remains" with a reason; MAYs are implemented or ticketed.
- `npm run verify` green; `npm run comments:en` green on every touched file.
- Redis and Postgres gated suites (`ESTELA_REDIS_URL`, `ESTELA_PG_URL`) run locally, output pasted in
  the PR "How it was tested".
- `test/multi-replica.e2e.spec.ts` passes with the shared fake in CI and with both real backends
  locally.
- README, AGENTS.md and the four skills updated as in section 9; AGENTS.md lists the new env-gated
  suites and dependency-cruiser rules.
- PR declares `ioredis` as a new devDependency; no runtime dependency added.
- Released as a minor (`feat`), no `BREAKING CHANGE` footer.
- The traceability table (section 15) has every MR row mapped to at least one test id that exists in
  the PR, and every test id of section 8 appears in at least one row.
- SD-35's contract test (SPI-433, when merged) passes against both shipped stores, or the PR states
  that SPI-433 has not merged yet.
- No adopter rule in this spec: enabling the guard before scaling is tracked by KA-01 to KA-03.

## 15. Traceability

| Requirement | Level | Tests | Ticket |
|---|---|---|---|
| MR-01 | MUST | RU1, RU2, BND1 | SPI-429 |
| MR-02 | MUST | PU1, PE1, BND1 | SPI-429 |
| MR-03 | MUST | RE1, PE2, CT1, E2 | SPI-429 |
| MR-04 | MUST | RU3, PU3, CT6, E5 | SPI-429 |
| MR-05 | MUST | RE2, PE3, CT4 | SPI-429 |
| MR-06 | MUST | RU4, PU4, CT7 | SPI-429 |
| MR-07 | MUST | RU5, PU5 | SPI-429 |
| MR-08 | MUST | RU6, PU6, CT3 | SPI-429 (floor below SPI-433) |
| MR-09 | MUST | RU7, PU7 | SPI-429 |
| MR-10 | MUST | RU8, RU9, PU8 | SPI-429 |
| MR-11 | MUST | RU10, PU9 | SPI-429 |
| MR-12 | MUST | SU1, SU2, SU3, E4 | SPI-429 |
| MR-13 | MUST | SU4, GU8 | SPI-429 |
| MR-14 | MUST | SU5 | SPI-429 |
| MR-15 | MUST | SU6 | SPI-429 |
| MR-16 | MUST | RU12, PU11, SU7 | SPI-429 |
| MR-17 | MUST | PE5, SU8 | SPI-429 |
| MR-18 | SHOULD | RU1 | SPI-429 |
| MR-19 | MAY | RU11, PU10 | SPI-429 |
| MR-20 | retired | none (D17) | n/a |
| MR-21 | MAY | RE3, PE4 | SPI-429 |
| MR-22 | MUST | GU2 | SPI-429 |
| MR-23 | MUST | GU3, E6 | SPI-429 |
| MR-24 | MUST | GU4 | SPI-429 |
| MR-25 | MUST | GU5 | SPI-429 |
| MR-26 | MUST | GU6, E6 | SPI-429 |
| MR-27 | MUST | GU7 | SPI-429 |
| MR-28 | SHOULD | GU1-GU5 | SPI-429 |
| MR-29 | SHOULD | GU9 | SPI-429 |
| MR-30 | MUST | HU1 | SPI-429 |
| MR-31 | MUST | DOC1, E7 | SPI-429 (cross-pod reply: SPI-434) |
| MR-32 | SHOULD | CT1-CT8 | SPI-429 |
| MR-33 | MUST | E1-E7 | SPI-429 |
| MR-34 | MUST | GU1 | SPI-429 |
| MR-35 | MUST | SU9 | SPI-429 |
| MR-36 | MUST | GU10, RU13, PU1 | SPI-429 |
| MR-37 | MUST | SU10 | SPI-429 |
| MR-38 | SHOULD | DI1 | SPI-429 |
