---
name: estela-flows
description: Author ESTELA channels, flows and activators correctly — channel selection matrix, flow DSL steps, replyChannel precedence, error semantics and the non-negotiable EIP invariants. Use when implementing message-driven features with ESTELA.
---

# estela-flows — author channels/flows/activators the ESTELA way

## Channel selection matrix

| Need | Channel |
|---|---|
| One consumer, ordered, awaited (HTTP entry, request/reply) | `direct` |
| N consumers, buffering, backpressure by capacity, eventual side effects | `queue` |
| Notify many, optional routing (`order.*`, `#`), consumer groups | `pubsub` |
| Mirror one emission to fixed targets + local listeners | `fanout` (bindings) |

## Flow DSL (all steps exist; do not reinvent)

`filter` · `transform` · `handle` · `wireTap` · `fanoutTo` · `jumpTo`/`jump` · `publish` · `route` · `to` · `reply`

Threading rule: one `msg` per invocation. `transform` replaces payload; destinations receive
copies/hops — activator returns never overwrite the parent payload. `to`/`route` terminate the
pipeline; `reply()` does not (put it before `to`, or last without `to`).

## replyChannel precedence — pass `reply` EXPLICITLY on every hop

| Hop | `nextHop` option | Why |
|---|---|---|
| `wireTap` / `fanoutTo` / `publish` | `reply:'none'` | side effects must never close the HTTP reply |
| `to` / `route` | `reply:'inherit'` | downstream activator may answer the inbound |
| `jump` | `reply:'reply.<uuid>'` | ephemeral channel; the parent keeps the inbound reply |

## Error semantics (memorize)

- **Awaited** (direct send, fanout `wait:true`, jump wait/timeout, `publish`, `to`): report to
  `error.channel` AND fail the flow (propagates to the producer).
- **Forget** (`wait:false`): never crashes the flow; envelope `{ fireAndForget:true, channel }` to `error.channel`.
- **wireTap**: swallows everything.
- **filter false**: success `{ filtered:true }`.
- **Duplicate** idempotency: silent; cached result re-sent to `replyChannel` when present.

## Activators

- `@ServiceActivator(channel, { group?, routingKey? })` / `@PubSub` alias. Signature: `(payload, msg)`.
- Return value + `replyChannel` present → wrapper auto-replies (this is the jump protocol).
- Idempotent scope: `activator:Class.method`; duplicate with cached result → re-send cached.

## Sagas (units of work across a database and the outside world)

```ts
saga<Ctx, Tx, Reply>('start')
  .idempotent((c) => c.key)
  .lock('flow', (c) => c.flowId, 'shared')                         // binds to the NEXT transaction
  .lock('flow-start', (c) => `${c.flowId}:${c.userId}`, 'exclusive') // per-user, not a global mutex
  .transaction('create', async (c, tx, unit) => {
    await transition(Instance, instances, tx, { id: c.id, to: 'RUNNING' }); // CAS, never a plain UPDATE
    unit.afterCommit(() => cache.del(c.id));                        // only after COMMIT
  })
  .outbound('notify', (c) => api.notify(c), { compensate: undo })   // never inside a tx, never retried
  .retry({ on: ['deadlock', 'lock-timeout', 'serialization'], attempts: 3, backoffMs: 20 })
  .reply((c) => c.reply);
```

- Consecutive `transaction` steps = one unit of work. Locks are taken once at its start (after the
  idempotency claim), deduplicated and canonically ordered; `.lock()` before an `outbound` or at the
  end is a `SagaDefinitionError`. `mode` is required: pick `shared` unless you mutate the guarded thing.
- `retry` re-runs only the failed unit, with `ctx` restored (`structuredClone`, or `checkpoint`
  for class instances, `#private` fields, symbol or non-enumerable keys, or a frozen root with
  mutable children; the default refuses those with `SagaUsageError` instead of skipping them). It needs a classifier (`TransactionPort.classify`). A ctx that becomes
  uncloneable after the first unit does not block compensation or the ledger record: that unit
  runs once, without retry, and the checkpoint error is logged.
- A saga started from inside a unit of work is rejected when either side uses locks or retry.
- `TransactionStep` takes `(ctx, tx, unit)`; a 2-argument implementation is fine, but code that
  calls a stored step or a `compensate` must forward `unit` (dropping it is a compile error).
- A lock protects a unit of work; a state machine + `transition()` protects the whole saga.
- Steps only touch the database (retries re-run them) and never swallow database errors.

## Anti-patterns (reject in review)

- Importing business classes from a flow (flows are strings + functions only).
- `void handler(...)` when subscribing a flow to an awaited channel (breaks producer waiting).
- Relying on ambient ALS across `setImmediate`/buffers — context is rebuilt from `msg.headers`.
- Adding Kafka/BullMQ to channels (v1 out of scope — propose an adapter instead).
