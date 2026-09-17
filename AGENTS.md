# AGENTS.md — ESTELA repo rules for AI agents (Claude · Codex · Cursor · any)

## Commands

- `npm run verify` — typecheck → build (ESM+CJS+d.ts) → jest → dependency-cruiser.
  **MUST pass before you finish any task.**
- The e2e HTTP test (`test/orders.e2e.spec.ts`) binds a loopback socket: run it with network permissions.

## Non-negotiable runtime invariants (SPEC §17 · PLAN §8)

1. Flows reference channels **by name only** — never import business classes.
2. `replyChannel` precedence per hop — every step passes `reply` **explicitly** to `nextHop`:
   `wireTap/fanout/publish → 'none'` · `to/route → 'inherit'` · `jump → its own ephemeral 'reply.<uuid>'`
   (the parent keeps the inbound reply untouched).
3. Awaited failures (direct send, fanout `wait:true`, jump timeout, `publish`, `to`) report to
   `error.channel` **and** fail the flow. Forget (`wait:false`) never crashes the flow.
   `wireTap` swallows all errors, always.
4. Ephemeral reply channels are unregistered in `finally` — `registry.list()` must return to baseline.
5. `direct` channel = one subscriber (last wins, warn on replace). For N consumers use `queue`/`pubsub`.
6. A direct channel must not be both an activator target and another flow's source —
   forward via the activator (see example: `orders.persist → orders.country`).
7. Dispatchers rebuild the ALS context from `msg.headers` at every dispatch — never trust ambient
   context across `setImmediate`/buffers/EventEmitter listeners.
8. Fanout bindings run the cycle guard: repeated channel in `history` or depth > 50 → `FanoutCycleError`.

## Layer boundaries (enforced by dependency-cruiser)

- `src/message.ts`, `src/channel.ts`, `src/flow/flow-step.ts` (domain): **zero npm imports**.
- Barrel `src/index.ts`: never imports `amqplib` or `@grpc/grpc-js` (transitively).
- `src/testing/`: never imports `src/inbound/` or `src/adapters/`.
- Optional peers (`amqplib`, `@grpc/grpc-js`, `@nestjs/graphql`) live only in `inbound/` and `adapters/`.

## Adding features (OCP)

- New channel kind → new `ChannelFactory` registered in `ChannelFactoryRegistry` (never a switch).
- New inbound transport → `InboundTransportStrategy` + `HeaderMapper`.
- New flow step → `FlowStep` class + builder method + `describe()` (graph) + tests.
- New idempotency backend → `IdempotencyStore` implementation (see README Redis contract).

## Testing rules

- Every invariant gets a test. Use `@acme/nest-integration/testing` helpers:
  `bindFlow` · `waitFor` · `collect` · `createTestMessage` · `MemoryIdempotencyStore`.
- Test files: `*.spec.ts` under `src/` or `test/` (jest roots).
- Handlers subscribed to awaited channels must return their promise (never `void p`) —
  producers of `direct` channels wait for full execution (spec §17.3).
