---
name: estela-review
description: Invariant checklist to review PRs touching ESTELA runtime or ESTELA-based apps — replyChannel precedence, error semantics, channel rules, boundaries and test coverage. Use when reviewing code that uses or extends ESTELA.
---

# estela-review — invariant checklist

Reject the PR if ANY of these fail:

- [ ] Flows import business classes or reference anything but channel names.
- [ ] Any `nextHop` call without an explicit `reply` option, or a fanout/wireTap/publish
      using `inherit` (side effects must use `none`).
- [ ] A jump that overwrites the parent's `replyChannel`, or a fanout that copies the inbound
      reply into targets (HTTP closing early).
- [ ] Forget (`wait:false`) able to crash the flow; wireTap able to fail the flow; filter false
      marking idempotency as failed instead of `{filtered:true}`.
- [ ] Ephemeral `reply.*` channels not unregistered in `finally` (add a registry-size assertion).
- [ ] `void`-discarded handler promise on a `direct`/awaited channel subscription.
- [ ] Direct channel with two consumers (flow source + activator) — must forward via a new channel.
- [ ] Queue overflow silently dropped (must throw `CapacityExceededError` → error.channel).
- [ ] Domain files (`message.ts`, `channel.ts`, `flow-step.ts`) importing npm packages; barrel
      importing amqplib/@grpc/grpc-js; `/testing` importing inbound/adapters.
- [ ] New switch-case instead of a registered factory/strategy (OCP violation: channels,
      transports, mappers, stores are maps).
- [ ] Saga using `SELECT ... FOR UPDATE` (or an exclusive lock) on a shared row as a global
      mutex for a per-user/per-entity invariant: lock the narrowest key, `shared` for readers.
- [ ] State changes written as a plain UPDATE instead of `transition()` (compare-and-set), or code
      that trusts a falsy/undefined update result as "no change": 0 rows must be `StaleStateError`.
- [ ] Non-database side effects (HTTP, cache, events) inside a saga `transaction` step: retries
      re-run them. Use `unit.afterCommit` (not durable) or an outbox, or an `outbound` step.
- [ ] A database error caught and swallowed inside a step (Postgres then turns COMMIT into ROLLBACK).
- [ ] Advisory locks used to protect a read-then-write check in a REPEATABLE READ transaction (the
      snapshot predates the lock wait): use READ COMMITTED, or SERIALIZABLE + retry on serialization.
- [ ] A hand-written retry loop around an Estela call (outbound request, channel send, saga step):
      use `care` so tries left, classification and events apply.
- [ ] Extra tries on more than one layer of the same call path (activator AND its outbound binding,
      or channel care AND its activator, `TRIES_STACKED`): keep them on the edge closest to the
      dependency.
- [ ] A plan B that hides the failure of a side effect (payment, write, message sent), or
      `planB.cacheable: true` on such a call.
- [ ] Valve or pace keys built from personal data hashed with a plain digest: `keyHasher` must be
      an HMAC with a secret of >= 32 bytes, and `keyLabel` must not echo the raw key.
- [ ] A side-effecting outbound binding without `tries.requireIdempotencyKey: true`.
- [ ] `'busy'` added to `valve.countOn` without a written reason (a 429 is not an outage).
- [ ] Inbound limits (`lanes`, `pace`) placed anywhere but the inbound spec: they must turn calls
      away before the idempotency claim.
- [ ] A flow step with extra tries and no idempotency key, or `tries.idempotent: true` without a
      written reason.
- [ ] An extra try toward a `pubsub` destination when not every subscriber is idempotent.
- [ ] A jump with extra tries toward a keyed activator whose `eachTryMs` is not longer than the
      activator's work.
- [ ] Channel care and the activator on that channel both trying again (`TRIES_STACKED` at boot).
- [ ] Missing tests for the touched invariant (error semantics + precedence always have tests).

Approve checklist: `npm run verify` green · invariants intact · graph/`describe()` updated
if steps changed · README/docs touched if public API changed.
