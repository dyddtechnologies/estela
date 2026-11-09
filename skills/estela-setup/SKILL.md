---
name: estela-setup
description: Wire the ESTELA EIP runtime (IntegrationModule.forRoot) into a NestJS app — channels, flows, activators, inbound adapters and error handling. Use when adding ESTELA to a NestJS project or bootstrapping message-driven features.
---

# estela-setup — adopt ESTELA in a NestJS app

## Install

```bash
npm install @estela/nest
# peers: @nestjs/common/core ^10||^11, @nestjs/swagger ^7||^8, reflect-metadata, rxjs
```

## Wire the module (global — do this once, in AppModule)

```ts
IntegrationModule.forRoot(
  {
    channels: [
      { name: 'orders.place', type: 'direct' },
      { name: 'orders.audit', type: 'queue', capacity: 10_000 },
      { name: 'inventory.reserve', type: 'direct' },
      { name: 'domain.events', type: 'pubsub' },
      { name: 'ops.fanout', type: 'fanout', bindings: ['inventory.reserve', 'billing.charge'] },
    ],
    errorChannel: 'error.channel',
    idempotency: { enabled: true },
    rabbitChannel,
    rabbitMappings: [{ queue: 'orders.q', channel: 'orders.place' }],
  },
  [PlaceOrderFlow, RouteByCountryFlow],
)
```

## Rules while wiring

1. Inbound is declared on controller methods with `@InboundRest/@InboundGrpc/@InboundGraphQL/@InboundRabbit` — **never** as channels in `forRoot`.
2. A `direct` channel must have exactly one consumer: either ONE flow source or ONE `@ServiceActivator`. If both are needed, forward via the activator to a new channel (pattern: `orders.persist` activator → sends to `orders.country` → next flow `from('orders.country')`).
3. `error.channel` (pubsub) is auto-created; envelope shape: `{ flow? | activator?, error, causedBy }`.
4. The module is `global: true` — feature modules can inject `ChannelRegistry`, `TraceContext`, `ReplyGateway`, `ChannelGraph` without importing.
5. Init order is fixed: channels → activators (discovered) → flows (`graph.recordFlow` + attach) → Rabbit explorer.

## Wire resilience (`forRoot({ resilience })`)

```ts
IntegrationModule.forRoot({
  channels,
  resilience: {
    policies: {                                     // named profiles, referenced by name anywhere
      'http-std': { timeout: { perAttemptMs: 2_000, deadlineMs: 8_000 },
                    retry: { maxAttempts: 3, requireIdempotencyKey: true },
                    circuitBreaker: { minimumCalls: 10, openMs: 30_000 } },
      'act-std':  { extends: 'http-std', retry: false, bulkhead: { maxConcurrent: 20 } },
    },
    defaults: { 'outbound-rest': 'http-std', activator: { bulkhead: { maxConcurrent: 50 } } },
    metrics: promPort,                              // ResilienceMetricsPort: counter / histogram / gauge
    keyHasher: (k) => createHmac('sha256', secret).update(k).digest('hex'), // HMAC, secret >= 32 bytes
    events: { channel: 'estela.resilience.events' },// default; false turns it off
    retryBudget: { initial: 2 },                    // optional budget for requests that arrive without one
  },
  outbound: { rest: { bindings: [{ name: 'pay.http', url, resilience: 'http-std' }] } },
});
```

- `forRoot({ resilience })` turns on the retry budget (`x-retry-budget`), the events channel and the
  injectable `ResilienceRegistry` (`breakerState`, `resetBreaker`). Without it, policies still run
  but no budget is read or sent.
- References everywhere: a profile name, an inline policy, `{ use: 'name', ...overrides }` (deep-merged
  once) or `false`. `defaults` keys are edge kinds (`outbound-rest`, `activator`, `saga-outbound`,
  `flow-handle`, `flow-jump`, `flow-send`); `inbound` is refused (use `inbound.resilience`, which
  takes `bulkhead` and `rateLimit` only).
- Invalid options fail boot with `ResilienceDefinitionError` (`code`, `path`, `findings`).
- Shared state across replicas: `state: redisResilienceStatePort(evalScript, { prefix })` on
  `rateLimit` and `circuitBreaker`. ioredis: `(s, k, a) => redis.eval(s, k.length, ...k, ...a)`;
  node-redis: `(s, k, a) => client.eval(s, { keys: [...k], arguments: [...a] })`. If Redis is down,
  each binding degrades to local state (`degradedLimitPerSec`, default `limitPerSec / replicasHint`)
  after `stateTimeoutMs` (100) and probes again every `stateProbeMs` (5000).
- A custom `circuitBreaker.key` / `rateLimit.key` with shared state needs `keyHasher`; use
  `keyLabel` (hashed) when keys may be personal data. Raw keys are never logged.
- Sagas: `new SagaRunner({ transactions, resilience: { policies, defaults } })` (or a
  `ResilienceRuntime`) resolves profile names of `.outbound(..., { resilience })` steps.

## Wire sagas (TransactionPort, locks, CAS)

```ts
import {
  HopLogger, SagaRunner, classifyPostgresError, postgresAdvisoryLockPort, postgresTransitionPort,
  type SqlQueryOf,
} from '@estela/nest';

// One query function fits every adapter (no pg dependency in Estela):
const query: SqlQueryOf<EntityManager> = (m) => (sql, params) => m.query(sql, [...params]);
// pg:     (c: PoolClient) => (s, p) => c.query(s, [...p])
// Prisma: (tx) => (s, p) => tx.$queryRawUnsafe(s, ...p)

const runner = new SagaRunner<EntityManager>({
  // run() must open a NEW top-level transaction (never join an ambient one).
  transactions: { run: (work) => dataSource.transaction(work), classify: classifyPostgresError },
  ledger: pgLedger,
  locks: postgresAdvisoryLockPort({ query, defaultTimeoutMs: 5_000 }),
  logger: new HopLogger(),
  onAfterCommitError: (error, info) => metrics.increment('after_commit_failed', info),
});
const instances = postgresTransitionPort({ query, table: 'instances', stateColumn: 'status', versionColumn: 'version' });
```

Map errors at the edge: `StaleStateError` -> 409; `LockTimeoutError` / `DeadlockError` /
`SerializationError` (all `ConcurrencyError`) -> 503 with `Retry-After`. Their `message` is safe
(kind, saga, unit, attempts); the driver error in `cause` names tables and constraints, so log it,
never return it.

- Lock keys: the advisory lock port hashes `(namespace, key)` to 64 bits of SHA-256, so keys may
  include user-chosen text without letting one user collide with another's lock. Code outside
  Estela that takes the same lock uses `ADVISORY_LOCK_KEY_SQL` with `[namespace, key]`. Postgres 11+.
- A custom classifier must return exactly `'lock-timeout'`, `'deadlock'`, `'serialization'` or
  `undefined`; anything else is treated as unclassified (no retry, original error rethrown).
- Prefer `retry()` over a retry loop inside `TransactionPort.run`. If the port does re-run `work`,
  the runner resets the claim, in-process locks and afterCommit callbacks per call.

- Isolation: advisory locks protect step reads only under READ COMMITTED. The lock port throws
  `SagaUsageError` in a REPEATABLE READ transaction (its snapshot predates the lock wait); opt out
  with `allowSnapshotIsolation: true` only if steps never read what the lock guards. Under
  SERIALIZABLE, retry on `'serialization'`.
- Prisma: `classifyPostgresError` reads raw-query `meta.code` and maps the ORM-level `P2034`
  (no SQLSTATE) to `deadlock`; list both `'deadlock'` and `'serialization'` in `retry.on`.
  A bigint `versionColumn` is read from Prisma's `bigint` values. Prisma binds strings as `text`,
  so a uuid id or an enum state column needs `idType: 'uuid'` / `stateType: 'schema.enum_name'`
  on `postgresTransitionPort` (pg and TypeORM need neither).
- Ledger: a retry policy on an idempotent saga needs a ledger that writes through `tx`.
  `MemoryIdempotencyLedger` (`transactional = false`) is refused there with `SagaUsageError`.
- `maxLocksPerUnit` (default 64) caps the lock requests of one unit: raise it deliberately for
  batch keys, never from unbounded user input.

## Verify adoption

- `moduleRef.get(ChannelRegistry).get('error.channel')` exists.
- `ChannelGraph.snapshot(registry)` shows your channels/flows/activators.
- Send a message through the entry channel; the flow runs end-to-end.
