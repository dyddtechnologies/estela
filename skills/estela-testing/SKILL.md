---
name: estela-testing
description: Test ESTELA flows, channels and activators deterministically with the /testing subpath — bindFlow, waitFor, collect, createTestMessage and the invariant checklists. Use when writing tests for ESTELA-based features.
---

# estela-testing — deterministic tests for ESTELA

## Helpers (`@estela/nest/testing`)

```ts
import { bindFlow, createTestMessage, waitFor, collect, MemoryIdempotencyStore }
  from '@estela/nest/testing';
import { IdempotencyService } from '@estela/nest';

bindFlow(PlaceOrderFlow, registry, {
  idempotency: new IdempotencyService({ store: new MemoryIdempotencyStore() }),
});
const done = waitFor(registry, 'out', 2_000);
const c = collect(registry, 'domain.events');
```

## What to assert per feature

1. **Happy path**: entry send → downstream channel receives transformed payload; `traceId` preserved.
2. **replyChannel precedence**: jumps reply into `jumpReplies` while the parent's inbound
   `replyChannel` stays intact; fanout targets never close the HTTP reply.
3. **Error semantics**: awaited failure → `error.channel` envelope + producer rejection;
   forget failure → flow continues; wireTap failure → total silence.
4. **Idempotency**: same key → single execution (transform spy called once) + duplicate cached reply.
5. **Lifecycle**: after `ReplyGateway`/jump — `registry.list()` back to baseline (no ephemeral leaks);
   queue `close()` drains pending messages.
6. **Fanout**: awaited blocks the pipeline until handlers finish; `wait:false` does not; A↔B bindings → `FanoutCycleError`, never a hang.

## Sagas

```ts
import { MemoryLockPort, MemoryTransitionPort, testUnitOfWork } from '@estela/nest/testing';

const locks = new MemoryLockPort();            // in-process only: NOT cross-process, no deadlock detection
const runner = new SagaRunner({ transactions: fakeTx, locks, sleep: async () => {}, random: () => 0 });
await runner.run(definition, ctx);
expect(locks.acquisitions).toEqual([[{ namespace: 'flow', key: 'f1', mode: 'shared' }]]);

const cas = new MemoryTransitionPort();
cas.seed('i1', 'PENDING');
cas.forceNext({ affected: 0 });               // next transition() -> StaleStateError

const unit = testUnitOfWork();                 // call a transaction step directly
await publishStep(ctx, tx, unit);
await unit.commit();                           // runs its afterCommit callbacks in order
```

- Fault injection: make the fake `TransactionPort.run` throw a pg-shaped error (`{ code: '40P01' }`)
  in the body or at COMMIT, and set `classify: classifyPostgresError`; assert the unit re-ran with
  `ctx` restored, outbound spies ran once, and afterCommit callbacks of the failed attempt never ran.
- `sleep` and `random` are seams: assert the backoff sequence instead of waiting.
- `MemoryIdempotencyLedger` cannot be combined with a retry policy on an idempotent saga (it is not
  transactional): use a fake ledger that stages its rows in the fake transaction.
- `MemoryLockPort` errors are `instanceof` the `@estela/nest` classes in both CJS and ESM builds
  (`ConcurrencyError` matches across bundled copies by brand and `kind`).
- Real-database behaviour (advisory locks, 40P01, CAS races) belongs in tests gated by an env var
  such as `ESTELA_PG_URL`, so CI stays database-free.

## Rules

- Handlers subscribed to awaited channels must RETURN their promise — `void p` breaks producer waiting (spec §17.3).
- Use fake timers/delays only at boundaries; prefer gates (`new Promise(res => (release = res))`).
- Channels under test: create via `registry.create({...})`; never depend on global state.
- Run `npm run verify` — jest + dependency-cruiser must be green.
