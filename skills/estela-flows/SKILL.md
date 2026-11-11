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
- **filter false**: success `{ filtered:true }`; silent by default, so a request/reply caller waits
  until its timeout. `filter(pred, { whenDropped: { reply: value | (payload, msg) => value } })`
  answers the caller's `replyChannel` at once (inbound request/reply, jump).
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
  .outbound('notify', (c) => api.notify(c), { compensate: undo })   // never inside a tx; tried again only with `care`
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

## Care

Where it goes (each takes a `CareRef`: a profile name, an inline `Care`, `{ use, ...over }`, or `false`):

| Subject | Option | Notes |
|---|---|---|
| Outbound REST binding | `care` on the binding, `outbound.rest.defaults`, `@OutboundRest`, ad-hoc `request()` | `timeoutMs` / `retry` stay as the 0.9.0 spellings (no tries left, no spread) |
| Activator | `@ServiceActivator(ch, { care })` | extra tries only with `idempotent: true` or a message key; prefer `lanes` + `patience` here |
| Inbound | `@InboundRest({ care })`, `inbound.care` | `lanes` / `pace` only; 429 + `Retry-After` before the idempotency claim; refused on Rabbit |
| Saga step | `.outbound(name, run, { compensate, care })` | no `planB`; `tries.max > 1` needs `tries.idempotent: true`; one hop; compensate once after the last try |
| Flow | `IntegrationFlow.from(src, { care: { handle?, jump?, send? } })` | L3 default per step family |
| Flow step / target | `handle(fn, { care })`, `jump(ch, { care })`, `jumpTo([{ channel, care }])`, `to`, `publish`, `fanoutTo`, `route` | L4; `filter`/`transform`/`reply` refuse it, `wireTap` never takes it |
| Channel | `{ name, type, care }` in `forRoot.channels` | L2: default of sends/jumps INTO it and of its activator; never inbound |

Precedence, highest first: call > step/target/endpoint (L4) > flow (L3) > destination channel (L2) >
`care.defaults[edge]` / module defaults (L1) > built-in (one direct try). **Merge rule:** each part
(`patience`, `tries`, `valve`, `lanes`, `pace`, `planB`) is taken whole from the highest level that
sets it, never merged field by field; `{ use, ...over }` is deep-merged once inside its level;
`false` cuts every level below. Tries left and `patience.totalMs` only narrow.

Per edge: `handle` → all parts, `planB` `value` or `channel`; `jump`/`jumpTo` → all, `planB` only
on awaited targets; `to` → all but `planB`, except `planB: { channel }` (plain send);
`publish`/`fanoutTo`/`route` → all but `planB`. A part not allowed at L4 fails boot
(`CARE_PART_NOT_ALLOWED`); inherited from L1..L3 it is dropped with one warning (`CARE_PART_DROPPED`).

- A flow step tries again only with an idempotency key on the message, a step key, or
  `tries.idempotent: true`; otherwise one try + `try.held` (boot: `TRIES_WITHOUT_KEY`).
- Extra tries belong on ONE layer, closest to the dependency. Channel care and its activator both
  trying again logs `TRIES_STACKED`; tries left (`x-tries-left`) cap the total.
- Plan B answers are never stored as an idempotent result (unless `cacheable: true`). Never use
  plan B to hide a side-effect failure.
- Read the running try's abort signal with `currentTrySignal()` inside activators, flow functions
  and saga steps.

## Anti-patterns (reject in review)

- Importing business classes from a flow (flows are strings + functions only).
- `void handler(...)` when subscribing a flow to an awaited channel (breaks producer waiting).
- Relying on ambient ALS across `setImmediate`/buffers — context is rebuilt from `msg.headers`.
- Adding Kafka/BullMQ to channels (v1 out of scope — propose an adapter instead).
- A hand-written retry loop around an Estela call (use `care` instead).
