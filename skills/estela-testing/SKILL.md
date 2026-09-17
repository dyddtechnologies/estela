---
name: estela-testing
description: Test ESTELA flows, channels and activators deterministically with the /testing subpath — bindFlow, waitFor, collect, createTestMessage and the invariant checklists. Use when writing tests for ESTELA-based features.
---

# estela-testing — deterministic tests for ESTELA

## Helpers (`@acme/nest-integration/testing`)

```ts
import { bindFlow, createTestMessage, waitFor, collect, MemoryIdempotencyStore }
  from '@acme/nest-integration/testing';
import { IdempotencyService } from '@acme/nest-integration';

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

## Rules

- Handlers subscribed to awaited channels must RETURN their promise — `void p` breaks producer waiting (spec §17.3).
- Use fake timers/delays only at boundaries; prefer gates (`new Promise(res => (release = res))`).
- Channels under test: create via `registry.create({...})`; never depend on global state.
- Run `npm run verify` — jest + dependency-cruiser must be green.
