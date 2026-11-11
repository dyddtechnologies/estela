---
name: estela-testing
description: Test ESTELA flows, channels and activators deterministically with the /testing subpath — bindFlow, waitFor, collect, createTestMessage, captureTrail/expectNoLeak and the invariant checklists. Use when writing tests for ESTELA-based features.
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

## Care

```ts
import { manualCareClock, MemoryCareState, collectCareEvents, bindFlow }
  from '@estela/nest/testing';
import { CareEngine } from '@estela/nest';

const clock = manualCareClock();                         // no real timers, no jest fake timers
const shared = new MemoryCareState(() => clock.wall());
const engine = new CareEngine({ clock, profiles }, { enabled: true }); // enabled = tries left on
bindFlow(OrderFlow, registry, { care: engine });         // resolves flow care like module boot

const sent = registry.send('orders.place', payload);     // a step with extra tries now waits on the clock
await clock.advance(200);                                // fires the spacing timer, settles promises
await sent;
```

- Module tests: `forRoot({ care: { clock } })` and `collectCareEvents(moduleRef).types()` to assert
  `try.again`, `valve.shut`, `plan-b.used`, `try.held`, `shared-state.lost`, ...
- Fault injection on shared state: `shared.down()` (every call throws), `shared.slow(ms)` (pair
  with a short `sharedStateWaitMs`), `shared.hang()` (never answers), `shared.failNext(n)`,
  `shared.up()`; assert the local `soloPerSecond` and exactly one `shared-state.lost` /
  `shared-state.back`.
- Make a failure transient with `Object.assign(new Error('x'), { transient: true })` (in-process
  classifier); anything else is unknown and gets no extra try.
- Assert tries by counting calls, `mapError` once, and one hop per call when `logging.hops` is on.
- Real Redis (`redisCareState`) belongs in a test gated by `ESTELA_REDIS_URL`.

## Privacy

```ts
import { captureTrail, expectNoLeak, leakForms, LeakForm } from '@estela/nest/testing';
import { PrivacyEngine, TrailOutput } from '@estela/nest';

const capture = captureTrail();                                // never { keepOriginals: true } here
const app = moduleRef.createNestApplication({ logger: capture.logger });
Logger.overrideLogger(capture.logger);
// forRoot({ idempotency: { store: capture.store(new MemoryIdempotencyStore()) }, privacy, ... })
capture.channel(moduleRef.get(ChannelRegistry), 'error.channel');   // envelopes
capture.channel(moduleRef.get(ChannelRegistry), 'orders.audit');    // wire-tap copies
const ledger = capture.ledger(new MemoryIdempotencyLedger());       // saga ledger rows

// drive success, failure, duplicate and replay with canary values, then:
expectNoLeak(capture, [jwt, apiKey, phone, email, card, idempotencyKey]);
```

- `expectNoLeak` checks every `LeakForm` (as is, base64/base64url at offsets 0..2, URI, form, JSON)
  and names only the secret's index and length (`secrets[1] (20 chars)`), never the secret or a
  hash of it. Use canaries, never real secrets.
- Assert both sides: the trail holds `[HIDDEN:<rule>]` / `fp:` tokens, while the delivered message
  and the caller's reply hold the real values (`expect(charged).toEqual([order])`).
- An inbound handler's own throw reaches Nest's `ExceptionsHandler`, an app surface: install a
  filter that logs `privacy.errorForTrail(error, { output: TrailOutput.Log })` in the test app.
- Durable records: assert the stored record per `remember` (`{ estelaOutcomeOnly: { v: 1 } }`, the
  sealed `estelaSealed` envelope) and the boot errors (`OUTCOME_ONLY_REPLAY`,
  `SEALED_WITHOUT_KEYS`); seal key outages throw `SealKeyUnavailableError` before the claim.
- Pack changes need positive and negative corpus tests (timestamps, ids, offsets must stay visible).

## Rules

- Handlers subscribed to awaited channels must RETURN their promise — `void p` breaks producer waiting (spec §17.3).
- Use fake timers/delays only at boundaries; prefer gates (`new Promise(res => (release = res))`).
- Channels under test: create via `registry.create({...})`; never depend on global state.
- Run `npm run verify` — jest + dependency-cruiser must be green.
