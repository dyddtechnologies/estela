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
- [ ] Missing tests for the touched invariant (error semantics + precedence always have tests).

Approve checklist: `npm run verify` green · invariants intact · graph/`describe()` updated
if steps changed · README/docs touched if public API changed.
