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

## Anti-patterns (reject in review)

- Importing business classes from a flow (flows are strings + functions only).
- `void handler(...)` when subscribing a flow to an awaited channel (breaks producer waiting).
- Relying on ambient ALS across `setImmediate`/buffers — context is rebuilt from `msg.headers`.
- Adding Kafka/BullMQ to channels (v1 out of scope — propose an adapter instead).
