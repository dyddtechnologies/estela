# Estela: resilience policy spec

Status: draft, not implemented. Base: `20ae298` (`chore(release): 0.9.0`), branch `docs/SPI-428-koletz-readiness-specs`. Amended 2026-11-09: section 2.13 applies the shared ESTELA flow parameter model (flow, step and channel parameters, named profiles); RS-03, RS-04, RS-27, RS-36, RS-37, RS-38, RS-42 and RS-50 are marked "(amended)". Cross-spec consistency pass (2026-11-09, with SPI-433, SPI-429 and the KA- spec): RS-53, RS-64, RS-66 and RS-67 are marked "(amended)"; OQ-1 is resolved; OQ-24 and OQ-25 are new. Second pass (2026-11-09): section 3.9 and section 12 take SD-67 (SPI-433 ships the shared scaffolding first). Vocabulary amendment (2026-11-10, D34): every public name follows the Estela-own vocabulary of section 18; changed requirements are marked "(amended)" and keep their IDs.

Shared flow parameter model: [`ESTELA_FLOW_PARAMETERS.md`](./ESTELA_FLOW_PARAMETERS.md) (proposed location; see the open location question).
Ticket: **SPI-445** (epic **SPI-428**). Requirement prefix: `RS-`.

This spec covers one deliverable: a resilience policy model native to Estela, the engine that runs it, and the places in Estela that apply it. It replaces section 4 ("Resilience") of the combined Koletz readiness draft (`voice-plat/docs/superpowers/specs/2026-11-09-estela-koletz-readiness.md`). That draft is superseded, and the sections below fix the review findings raised on it. The library stays generic. Every Koletz rule (guardrail 9, quota handling for specific providers, per-channel configuration) lives in the Koletz adoption spec (`KA-` prefix), never here.

Normative words follow RFC 2119: MUST, MUST NOT, SHOULD, MAY.

## 0. Motivation and scope

### 0.1 What Estela does today (verified against the code at `20ae298`)

| Area | Behaviour today | Evidence |
|---|---|---|
| Outbound REST timeout | Each attempt runs under an `AbortController` plus a `Promise.race`, so the timeout wins even when the fetch ignores the signal. Default 30000 ms, `0` turns it off. The precedence is call > target > binding > module. | `outbound/outbound.call.ts:89-108`, `outbound/outbound.plan.ts:25,340`, `outbound/outbound.request.ts:185` |
| Outbound REST retry | Off unless configured (`outbound.plan.ts:241-242`). Default 3 attempts (`:27`). `maxAttempts` must be an integer >= 1 with **no upper bound**, else `OutboundError` (`:244-246`). Default backoff is exponential from 200 ms, factor 2, capped at 10000 ms, with **no jitter** (`:29,230-235`). A backoff function's result is clamped to >= 0 (`outbound.call.ts:153`). | `outbound/outbound.plan.ts` |
| Layering of `retry` and `idempotency` | `layer()` merges the module default and the binding **field by field** (binding fields win), and `enabled` is not inherited once the binding passes an object. | `outbound/outbound.plan.ts:125-151` |
| Retry classifier | Default: anything that is not an `OutboundHttpError` (network errors and timeouts), plus HTTP 408, 429 and every status >= 500, 501 included. The classifier returns `MaybePromise<boolean>` and may be a function, an object or a provider ref. It is called only after the attempts-left and repeatable checks pass. | `outbound/outbound.plan.ts:225-228,250-253`, `outbound/outbound.types.ts:238-245`, `outbound/outbound.call.ts:148-152` |
| Idempotency gating | A retry also needs a repeatable method: GET, HEAD or OPTIONS, any method while an idempotency key is sent, or a method listed in `tries.methods`. | `outbound/outbound.call.ts:32,142-154` |
| Request identity | The request is built once, so every attempt carries the same idempotency key. The target resolver, header mapper and key resolver run once, before the first attempt. | `outbound/outbound.call.ts:191-212`, `outbound/outbound.request.ts:155-190` |
| Response mapping | `plan.response` runs after a successful attempt. A response mapper that throws is neither retried nor passed to `mapError` (README caveat). | `outbound/outbound.call.ts:173-175`, `README.md:510-512` |
| Error mapping and logging | `mapError` runs once, after the last attempt (`outbound.call.ts:179`). One hop line is written per call, never per attempt (`:203,210`). | `outbound/outbound.call.ts` |
| Call-level options | `request(target, message, call)` accepts only `timeoutMs`, `idempotencyKey` and `headers` per call. Ad-hoc `OutboundRestRequestOptions` are planned once per options **object** and cached in a `WeakMap`. | `outbound/outbound.types.ts:100-105`, `outbound/outbound-rest.gateway.ts:57,105-113` |
| Header mappers | The HTTP, gRPC and AMQP mappers carry only the trace headers and the idempotency key, both in and out. `bindGrpcOut` uses the same `mapOut`. | `adapters/header-mapper.ts:8-62`, `adapters/grpc.adapter.ts:18-19` |
| Missing pieces | No overall deadline, no `Retry-After` handling (README "Outbound REST" caveats, `README.md:513`), no circuit breaker, bulkhead, rate limiter or fallback. | whole `src/` tree |
| Outbound gRPC | `bindGrpcOut` calls an injected stub with no deadline, retry or error typing. | `adapters/grpc.adapter.ts:12-31` |
| Activators | `ActivatorOptions` has only `group` and `routingKey`, so an activator has no timeout or concurrency cap. With a message `idempotencyKey`, the wrapper claims once, runs the method, and stores a defined result as `cachedResult` (`activator-wrapper.ts:85-106`). | `decorators.ts:8-11`, `activator/activator-wrapper.ts:75-115` |
| Inbound | `InboundSpec` has no load-shedding option. The interceptor runs the handler first and then dispatches; the idempotency claim happens inside `dispatch` (`:131`). A request/reply inbound stores the reply payload as `cachedResult` (`:161-163`). `ReplyGateway.sendAndReceive` returns the reply payload only, not its headers. Transport strategies expose raw headers only through `extract(context, handlerResult, spec)`, which needs the handler result. | `inbound/inbound.types.ts:11-27`, `inbound/inbound.interceptor.ts:104-168`, `gateway/reply-gateway.ts:28-34`, `inbound/inbound.transport.ts:15` |
| Saga outbound steps | Never retried by the saga `RetryPolicy`, which only re-runs units of work. `OutboundOptions` has only `compensate` and `compensateLocks`. | `saga/retry-policy.ts:5-8`, `saga/saga.ts:66-72`, `saga/saga-runner.ts:296-321` |
| Reusable backoff | `delayFor(policy, attempt, random)` takes `{ backoffMs, maxBackoffMs, jitter }`. The factor is fixed at 2, the default cap is `backoffMs * 32`, and `JitterMode` is `'full' \| 'equal' \| 'none'` (default `'full'`). It has **no `factor` option**. The randomness comes from `node:crypto` `randomInt`, which avoids the sonarjs pseudo-random hotspot. `MAX_RETRY_ATTEMPTS = 20`. | `saga/retry-policy.ts:3,25-49`, `saga/saga-runner.ts:1,104` |
| Errors | `ChannelError(message)` takes no `cause` option. `ConcurrencyError` shows the cross-bundle brand pattern. | `channel.ts:37-42`, `saga/concurrency-errors.ts:22-61` |
| Graph | `OutboundTransport = 'rest'` only. `GraphOutboundRef` holds `{ transport, target }`, and `recordOutbound` copies only those two fields. | `graph/channel-graph.ts:12-18,119-123` |
| Flow DSL | `IntegrationFlow.from(source)` takes no options. `filter`, `transform`, `handle`, `wireTap`, `fanoutTo`, `jumpTo`, `publish`, `route` and `to` take no resilience option. Only `jump(channel, { wait?, timeoutMs? })` has options. A flow step has no timeout, retry or concurrency cap other than the jump wait. `recordFlow` stores each step's `describe()` output as is. | `flow/integration-flow.ts:41-99`, `graph/channel-graph.ts:125-128` |
| Jump | Each awaited target opens `reply.<uuid>`, sends the hop, and waits for the first reply for `timeoutMs ?? 10000` ms. In `finally` it cancels the wait and unregisters the channel. It keeps only `reply.payload`, so reply headers (such as a `degraded` mark) are dropped. `JumpTimeoutError` extends `Error`, not `ChannelError`, and has no `retryable` flag. `wait: false` targets go to `reportFireAndForget`, and their late reply still writes into the `jumpReplies` object that the continued message already holds. | `flow/steps/jump.step.ts:13,36-47,56-77`, `flow/flow-step.ts:55-60`, `flow/steps/forget.ts:9-25` |
| What a send means per channel kind | `direct`: `send` awaits the single subscriber, so a send step fails with the downstream handler's error, or with `NoSubscriberError` when there is none. `queue`: `send` resolves once buffered and rejects with `CapacityExceededError` when full. `pubsub`: `Promise.allSettled` over subscribers, with failures sent to `onError`; the send never rejects. `fanout`: awaits each binding, `ChannelNotFoundError` for a missing one. The channel errors set `name = new.target.name`. | `channels/direct.channel.ts:12,32-34`, `channels/queue.channel.ts:24-26,55-58`, `channels/pubsub.channel.ts:21-22,63`, `channels/fanout.channel.ts:64-80`, `channel.ts:37-62` |
| Send steps | `to`, `publish`, `fanoutTo` and `route` build one `nextHop` per target and send it once. `route` calls its function once, then sends to every returned channel with `Promise.all`. Awaited fanout targets are joined with `Promise.all`; `wait: false` targets go to `reportFireAndForget`. | `flow/steps/to.step.ts:14-23`, `flow/steps/publish.step.ts:17-25`, `flow/steps/fanout.step.ts:19-32`, `flow/steps/route.step.ts:19-32` |
| Flow claim and errors | The flow claims `flow:<name>` with `headers.idempotencyKey`, the module TTL (default 3600000) and the module store. It completes with `{ completed: true }` or `{ filtered: true }`, calls `fail` on error, and sends one envelope `{ flow, error, causedBy }` to `error.channel`. A step that throws fails the whole flow; there is no per-step retry. | `flow/flow-executor.ts:32,58-85,106-127,139-150` |
| Activator duplicates | A duplicate key replies only with a stored `cachedResult`. An in-flight claim, or one completed with an `undefined` result, answers nothing. | `activator/activator-wrapper.ts:85-90,160-174` |
| Boot order | Channels (step 1); then activators, the inbound log and outbound bindings (step 2); then flows, with `recordFlow` and `attachTo` (step 3); then the Rabbit explorer (step 4). | `integration.module.ts:245-286` |
| Channel declaration | `ChannelSpec { name, type, capacity?, bindings? }`, with no per-channel policy. | `channel-factory.ts:9-14` |

### 0.2 Verified premise

On 2026-11-09, ms-ai-core and ms-campaigns each ran **one replica** in dev and in qa, with no HPA. Shared state across pods is therefore not needed for correctness today. It becomes a prerequisite the moment someone scales a service. This spec ships local state as the default and shared state as an opt-in port. Shared state is a **P1 scaling item, not a current outage**. The boot guard that stops a service from scaling onto per-pod state belongs to the multi-replica spec (SPI-429, `MR-` prefix), not here.

### 0.3 Why

Koletz will route every call of ms-ai-core and ms-campaigns through Estela, including LLM providers, Twilio through ms-whatsapp, ms-billing and the internal gRPC commands. With only a per-attempt timeout and an optional retry, Estela cannot:
- stop calling a provider that is down (no breaker);
- cap the concurrency an LLM turn may take (no bulkhead);
- share a per-sender throughput budget (no rate limiter);
- bound a whole call (no deadline);
- respect `Retry-After`;
- stop retries from multiplying across layers.

### 0.4 Scope (this ticket)

1. A policy model with these primitives: per-attempt timeout, overall deadline, retry (classifier, backoff, jitter, `Retry-After`, idempotency gating), circuit breaker keyed by a function, bulkhead, token-bucket rate limiter with optional shared state, and fallback.
2. A native engine with zero runtime dependencies that composes the primitives in one fixed order.
3. A failure classification model (`FailureClass`) with default classifiers for REST, gRPC and in-process edges (activators, saga steps). Quota-style failures are a classifier hook, not a built-in rule.
4. Retry-budget propagation, so that retries do not multiply across layers.
5. A shared-state port (`CareStatePort`), a reference Redis adapter that takes a script function from the app, and the degraded behaviour when that state is unavailable (D-REDIS-DOWN).
6. Application points:
   - outbound REST, where today's `retry` and `timeoutMs` become aliases with identical semantics;
   - activators;
   - inbound load shedding (bulkhead and rate limit only), mapped to 429 or `RESOURCE_EXHAUSTED`;
   - saga outbound steps;
   - flow steps and channels (`handle`, `jump`/`jumpTo`, `to`, `publish`, `route`, `fanoutTo`), with flow-level defaults, channel defaults and named reusable profiles (section 2.13).
7. The edge-adapter contract that SPI-430 (outbound gRPC) and SPI-436 (SDK outbound) use to apply the same engine.
8. Observability: an events channel, a metrics port and graph annotations.
9. Operational control: a `CareControl` provider that reads and resets breakers, and a manual-close mode for quota openings.
10. An opt-in rule that refuses non-safe calls without an idempotency key (`tries.requireIdempotencyKey`).
11. Testing helpers, documentation and skills.

This scope differs from the ticket map of the superseded draft (section 8 there), which put activators and inbound shedding under SPI-430/SPI-436 and the metrics port and events under SPI-444. They move here because they use the same executor and cannot be tested apart from it (D18). SPI-444 keeps only the measurement.

### 0.5 Non-goals

- **An external engine.** No cockatiel or opossum adapter. The previous draft's `ResilienceEngine` port is dropped because there is no real need for it (D2). It is noted as future work only.
- **Wiring the engine into `OutboundGrpcGateway` and SDK outbound.** Those adapters belong to SPI-430 and SPI-436. This spec gives them the contract (RS-39) and the default gRPC classifier (RS-15).
- **Broker-backed channels (SPI-434).** No requirement here depends on them. The retry budget travels in message headers, so it will cross a broker hop once SPI-434 lands, but nothing is specified for that case.
- **Propagating deadlines downstream** (an `x-request-deadline` header, or a gRPC deadline from the remaining budget). This is open question OQ-4. SPI-430 decides the gRPC native deadline.
- **Adaptive concurrency, hedged requests, slow-call breaker thresholds, per-key bulkheads (OQ-6), and load shedding for Rabbit inbound.** The broker prefetch already does that job for Rabbit.
- **Performance budgets.** They are measured and set in SPI-444 (section 9). This spec invents no latency or throughput numbers.
- **Masking payloads, and the sensitive-data policy in general.** These belong to SPI-433 (`SD-`). This spec only states what the resilience code itself writes to sinks (section 7.3).

## 1. Backward-compatibility contract

**Untouched configurations.** A binding, activator, inbound endpoint or saga that configures no `care` option behaves byte-for-byte as in 0.9.0:
- the same requests, headers, attempts, delays, errors and hop lines;
- the same graph JSON, with no new keys;
- `outbound.spec.ts`, `outbound.module.spec.ts`, `test/outbound-rest.e2e.spec.ts`, `saga.spec.ts` and the activator and inbound specs all pass unmodified.

This also covers a binding that uses only the legacy `timeoutMs` and `retry` options (section 1.1).

**Migration of today's outbound REST options.** `timeoutMs` and `retry` stay, as **aliases** of the new model with **identical semantics**. Nothing about them changes in this release, and no deprecation warning is logged (OQ-5).

| Today (0.9.0) | Equivalent `care` plan built by the alias | Detail kept identical |
|---|---|---|
| `timeoutMs: N` (binding, module default, target, call) | `patience.eachTryMs: N` | Same precedence, call > target > binding > module (`outbound.request.ts:185`). `0` means no timeout. Same `OutboundTimeoutError`. Same validation: any finite number >= 0, else `OutboundError` (`outbound.plan.ts:164-169`), not the integer rule of section 5.6. |
| `retry: { maxAttempts, backoff, retryOn, methods }` | `tries: { max, spacing, methods }` plus a legacy classifier | Backoff: the same function (`initialMs * factor^(n-1)` capped at `maxMs`, clamped to >= 0), **no jitter**. Layering stays field by field (`outbound.plan.ts:137-151`). Validation stays the 0.9.0 one: `maxAttempts` integer >= 1 with no upper bound, errors are `OutboundError`. `retryOn` keeps its boolean, possibly async, contract and its function, object and provider-ref forms: true maps to `'transient'`, false to `'rejected'`. It is still called only when attempts are left and the method is repeatable, so a user classifier sees the same number of calls. The default classifier is still the 0.9.0 one (`outbound.plan.ts:225-228`), so 429 and every 5xx are retried. |
| (implicit) | `heedServerWait: false`, tries left ignored, no `valve`, `lanes`, `pace` or `planB` | No `x-tries-left` header is read or sent, even when the module sets `forRoot({ care })` (R11). |
| `retry: false` at binding level | `tries: false` | Turns off a module default, as today. |

**What is new and opt-in only.** The `care` key on a binding, a module default, an `@ServiceActivator`, an inbound spec, a saga outbound step, a call (RS-68), a flow, a flow step or target, a channel or `bindGrpcOut` (section 2.13), and `forRoot({ care })`. Under `care`, the REST defaults differ from the alias defaults: full jitter, `Retry-After` honoured, the classifier of RS-14, and a retry budget. These differences only apply to code that opts in.

**Type changes.** Every change to an existing public type is additive and optional:
- `ActivatorOptions.care?`
- `InboundSpec.care?`
- `InboundDefaults.care?`
- `OutboundRestOptions.care?`
- `OutboundOptions.care?` (saga)
- `GraphOutboundRef.care?`, `GraphInboundRef.care?`
- `IntegrationModuleOptions.care?`
- `InboundTransportStrategy.rawHeaders?(context)`: an **optional** method on a port that consumers implement. A custom strategy without it keeps working: its shed context gets `rawHeaders: {}` (RS-37). Because the method is optional, this is not a breaking change under the AGENTS.md rule.

One parameter type widens in two places: `OutboundErrorMapperFn` and `OutboundErrorMapper.mapError` now receive `OutboundRestError | CareError`. The function type uses the existing `bivarianceHack` pattern (`outbound.types.ts:215-217`), and the interface uses method syntax (`:223-225`), which TypeScript checks bivariantly. Every existing mapper therefore still compiles. Only a binding that opts into `care` can ever pass a `CareError`, so existing mappers never see one at run time.

New injectable: `CareControl` (RS-49), provided only when `forRoot({ care })` is set.

**Flow DSL and channel types (section 2.13).** Every change is an optional trailing parameter or an optional field, so existing flows compile and run unchanged (RS-70):
- `IntegrationFlow.from(source, options?)`; `filter`, `transform`, `handle`, `wireTap`, `to`, `route` and `reply` gain an optional `opts`; `publish` gains an overload; `jump` options gain `care?`, `sensitive?` and `id?`.
- `fanoutTo` and `jumpTo` take `FlowDest[]`. `FlowTarget` extends `FanoutTargetInput`, so every existing `FanoutDest[]` value still type-checks. `FanoutDest` and `FanoutTargetInput` stay exported.
- `ChannelSpec.care?`, `CareModuleOptions.profiles?` and `.defaults?`.
- `ActivatorOptions.care`, `OutboundRestOptions.care`, `InboundSpec.care`, `InboundDefaults.care` and saga `OutboundOptions.care` widen from a policy object to a reference (`CareRef` or `InboundCareRef`). The inline object form stays valid, so this widening breaks no caller.
- `CareEdge` gains `'flow-handle' | 'flow-jump' | 'flow-send'`. Because `CareEdge` is new in this release, adding members breaks nobody only if the flow integration ships in the **same** release. If it ships later, consumers' exhaustive `switch` statements on the union stop compiling (OQ-22).
- Graph JSON for unconfigured flows does not change: the step keys `id`, `care` and `repeatableBy` appear only on configured steps (RS-66).

**Releases and tooling.**
- The release is a minor one (`feat`), with no `BREAKING CHANGE` footer.
- The emitted `.d.ts` stays parseable by TypeScript 4.9, checked by `test/dist-typescript4.spec.ts`.
- `delayFor`, `JitterMode`, `MAX_RETRY_ATTEMPTS` and `MAX_BACKOFF_MS` move to `src/resilience/backoff.ts`, because `src/resilience/` may not import `src/saga/` (section 4). `saga/retry-policy.ts` re-exports them, so saga behaviour and imports do not change. `delayFor` and `backoffDelay` stay internal: `delayFor` is not in the public barrel today (`src/index.ts`), and neither is added. `JitterMode` stays public through `saga/saga.ts:6`. A new `backoffDelay` adds the `factor` option (RS-10); `delayFor` stays a wrapper with byte-identical output, which RU-10 checks against the 0.9.0 function.

## 2. Requirements

Every requirement has an acceptance criterion and at least one named test (section 10). The traceability table is in section 17. Unless the table says otherwise, the ticket for all of them is **SPI-445**.

### 2.1 Model, composition and configuration

| ID | Level | Requirement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| RS-01 (amended) | MUST | Estela defines `Care` with the optional parts `patience`, `tries`, `valve`, `lanes`, `pace` and `planB`, plus the care-wide `classify` hook. A policy with no primitive runs the call once, directly, with no added timers. | Given `care: {}`. When a call is made. Then exactly one attempt runs, and no timer and no event are created. | RU-01 |
| RS-02 (amended) | MUST | The engine composes primitives in one fixed order, outermost first: `planB`, `patience.total`, `lanes`, `tries`, `valve`, `pace`, `patience.eachTry`, call. The order is the same for every edge kind and cannot be configured. | Given a policy with every primitive. When a call fails twice and then succeeds. Then each attempt passes through the breaker and the rate limiter (2 failures recorded, 3 tokens taken), the bulkhead slot is taken once, and the deadline covers the whole sequence. | RU-02 |
| RS-03 (amended) | MUST | Policies of declared bindings, decorators, inbound specs and saga steps are validated when they are declared, at boot. **Amendment:** boot-time policies, including every flow, flow step, channel, profile and `defaults` reference, are resolved in one `FlowParameterResolver` pass (RS-67) that collects every finding before it throws; the thrown `CareConfigError` lists them in `findings`, and its message keeps the `<subject>: care.<path> <rule>` shape. Policies of ad-hoc `request()` options are validated on the first call, as today. An invalid value throws `CareConfigError` naming the binding and the option path (for example `orders.http: care.tries.maxAttempts must be an integer 1..20`). Section 5.6 lists every rule. | Given `maxAttempts: 0` on a declared binding. When the module boots. Then boot fails with `CareConfigError` and that message, and no message is processed. Given two invalid subjects. Then one error is thrown and its `findings` has two entries. | RU-03, RE-07 |
| RS-04 (amended) | MUST | Precedence follows the levels of section 2.13 (RS-51): call (L5, RS-68) > step or endpoint (L4: binding, decorator, ad-hoc `request()` options, inbound spec, saga step, flow step or target) > flow (L3) > channel (L2) > module (L1: `care.defaults`, `outbound.rest.defaults`, `InboundDefaults`) > built-in (L0). For values under `care`, each part (`patience`, `tries`, `valve`, `lanes`, `pace`, `planB`, `classify`) is **replaced whole** by the highest level that sets it, and the other parts keep inheriting (RS-52). Inside one reference, inline fields deep-merge once over the named profile (`use`). `false` turns a part off. A per-target or per-call `timeoutMs` still overrides `eachTryMs` (call > target > binding > module). The 0.9.0 spellings `retry` and `timeoutMs` keep the 0.9.0 field-by-field `layer()` rule of `outbound.plan.ts:137-151`, including "`enabled` is not inherited once the binding passes an object" (section 1). **Was:** binding fields merged field by field over the module default, and no call-level `care`. Changed to the shared flow parameter model (D24, OQ-12). Nothing shipped depends on the old rule, because `care` is new in this release. | Given a module default `care.defaults['outbound-rest']` = `{ tries: { max: 5 } }` and a binding `care: { tries: { spacing: 50 } }`. When the plan is resolved. Then the binding makes up to 3 tries (built-in `tries.max`) with 50 ms gaps, because the binding owns `tries`. Given a binding `{ use: 'p', tries: { spacing: 50 } }` where `p` sets `tries: { max: 5 }`. Then 5 tries with 50 ms gaps. Given a binding with `valve: false` and a module default with a `valve` and `patience`. Then it has no valve and keeps the module `patience`. Given the legacy `retry: { maxAttempts: 5 }` on the module default and `retry: { backoff: 50 }` on the binding. Then 5 attempts with 50 ms delays, as in 0.9.0. | RU-04 |
| RS-05 | MUST | `src/resilience/` imports no npm package. Only `node:` core modules are allowed. The new depcruise rule `resilience-no-npm` enforces this, and no runtime dependency is added to `package.json`. | Given the dependency-cruiser config. When `npm run bounds` runs. Then a test import of an npm package under `src/resilience/` fails the rule. | RU-05 |

### 2.2 Timeout and deadline

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-06 (amended) | MUST | `patience.eachTryMs` aborts the attempt's `AbortSignal` and rejects the attempt even when the work ignores the signal, which keeps today's behaviour (`outbound.call.ts:89-108`). The edge adapter builds the error (REST: `OutboundTimeoutError`). | Given `eachTryMs: 100` and a fetch that never settles and ignores the signal. When the call runs. Then it rejects at 100 ms on the manual clock, and the signal it saw is aborted. | RU-06 |
| RS-07 (amended) | MUST | `patience.totalMs` bounds the whole call: bulkhead queue wait, every attempt, every backoff and every rate-limit wait. The timeout of each attempt is `min(eachTryMs, remaining deadline)`. No sleep or wait goes past the deadline. When the deadline expires, the call fails with `OutOfTimeError`, whose `cause` is the last attempt's error (or `undefined`). An attempt cut short by the deadline (its timeout was the remaining deadline, not `eachTryMs`) is **not recorded** by the breaker, because the dependency did not fail. | Given `totalMs: 1000`, a backoff of 600 ms and attempts that each fail after 300 ms. When the call runs. Then attempt 2 gets a 100 ms timeout, no third attempt starts, the error is `OutOfTimeError` with `cause` set to attempt 2's timeout error, and the breaker recorded 1 failure, not 2. | RU-07a, RU-07b |

### 2.3 Retry

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-08 (amended) | MUST | A failed attempt is retried only when all of these hold: its class is in `tries.on` (default `['transient', 'busy']`); attempts are left; the retry budget allows it (RS-29 to RS-31); the deadline leaves room for the delay; and the operation is repeatable (RS-09). | Given a `'rejected'` failure (HTTP 400). When the call runs. Then exactly one attempt is made. | RU-08 |
| RS-09 (amended) | MUST | **Idempotency gating.** A non-safe operation is retried only while an idempotency key is sent or the binding declares it repeatable. REST: GET, HEAD, OPTIONS, a key present, or `tries.methods`, as today. Activators and saga outbound steps: `tries.idempotent: true` or a message `idempotencyKey`. SDK and gRPC: decided by their adapters through `CareEdgeAdapter.repeatable`. The key is identical on every attempt. A timed-out attempt of a non-repeatable operation is never retried, because its outcome is unknown. | Given a POST with no key and no `methods`, and a timeout on attempt 1. When the call runs. Then the call fails after 1 attempt. Given the same call with a key. Then attempt 2 sends the same key. | RU-09a, RU-09b |
| RS-10 (amended) | MUST | `tries.spacing` is exponential (`firstMs` 200, `growth` 2, `capMs` 10000) with `spread: 'full'` by default under `care` (`'half'` is the legacy `'equal'` jitter). It is computed by `backoffDelay` in `src/resilience/backoff.ts`, which generalises `delayFor` with a growth factor, and an injectable `random` whose default is `node:crypto` `randomInt`. A number gives a fixed delay. A `SpacingFn` receives `(tryNumber, error)`, and its result is clamped to `0..2147483647`. | Given `random = () => 0` and `spread: 'full'`. When try 1 fails. Then the delay is 0. Given `spread: 'none'`. Then the delays are 200 and then 400. Given `growth: 3, spread: 'none'`. Then they are 200 and then 600. Given the saga inputs of `delayFor`. Then `delayFor` returns the same values as in 0.9.0. | RU-10 |
| RS-11 (amended) | MUST | **`Retry-After`.** When `heedServerWait` is true (the default under `care`) and the classification carries `readyInMs`, the delay is `max(backoff, readyInMs)`. If `readyInMs > maxServerWaitMs` (default `spacing.capMs`), the attempt is **not** retried and its error is final. If the delay is longer than the remaining deadline, the call ends at once with `OutOfTimeError`. The REST default classifier parses delta-seconds and HTTP-date. Negative, non-numeric or unparseable values are ignored, and the call behaves as if the header were absent. | Given a 429 with `Retry-After: 2`. When `maxServerWaitMs` is 10000. Then the next attempt starts 2000 ms later. Given `Retry-After: 3600`. Then there is no retry and the 429 is final. Given `Retry-After: soon`. Then the normal backoff is used. | RU-11a, RU-11b, RU-11c |
| RS-12 (amended) | MUST | A rejection the engine produces itself (`ValveShutError`, `LanesFullError`, `OverPaceError`, `OutOfTimeError`) is never retried by the layer that produced it. When it happens on attempt 2 or later (for example the breaker opened during the backoff), its `cause` is the previous attempt's error. | Given an open breaker and `maxAttempts: 5`. When the call runs. Then it fails with `ValveShutError` after 0 calls to the dependency. Given a breaker that opens during the backoff after attempt 1 failed with `E`. Then the call fails with `ValveShutError` whose `cause` is `E`. | RU-12 |

### 2.4 Failure classification

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-13 (amended) | MUST | Every failure is classified into exactly one `FailureClass`: `'transient' \| 'busy' \| 'rejected' \| 'quota' \| 'unknown'`. Classifiers in `classify` (one function or an ordered array) run first, and the first non-`undefined` result wins. The edge default comes next, and `'unknown'` is the last resort. A classifier that throws is treated as returning `'unknown'`, and its error is logged once at error level. The call is never crashed by a classifier. | Given `classify: [() => undefined, () => 'quota']`. When a 503 fails. Then its class is `'quota'`. Given a classifier that throws. Then the class is `'unknown'` and one error line is logged. | RU-13a, RU-13b |
| RS-14 (amended) | MUST | The default REST classifier (under `care`) maps failures as in the table of section 5.2. It never returns `'quota'`. It sees only the failures of an attempt (`OutboundRestError` values). Target, header and key resolvers run before the executor, and the response mapper runs after a successful attempt, so their errors are never classified, retried, recorded or passed to the fallback. They triesLeft unchanged, as in 0.9.0. | Table-driven test over every row of section 5.2. Given a response mapper that throws after a 200. Then the error propagates, `mapError` is not called, and the breaker records a success. | RU-14 |
| RS-15 (amended) | MUST | The default gRPC classifier is shipped here as a pure function of the numeric status code and of the raw `grpc-retry-pushback-ms` value when there is one. It does not import `@grpc/grpc-js`. It maps codes as in section 5.2 and never returns `'quota'`. Following the gRPC retry design (gRFC A6), a pushback value that is negative or not an integer means "do not retry", so the class becomes `'rejected'`. SPI-430 wires it in. | Table-driven test over the 17 gRPC codes. Given code 8 with pushback `'250'`. Then `{ class: 'busy', readyInMs: 250 }`. Given pushback `'-1'` or `'x'`. Then `'rejected'`. | RU-15 |
| RS-16 (amended) | MUST | The `'quota'` class is generic. It is never retried. It **forces the breaker for that key open**, even below `minCalls`, and writes the shared open marker when shared state is configured. How long the opening lasts is chosen by the enum `valve.onQuota` (D35): `OnQuota.ShutLikeFailure` (default) shuts for `shutMs`, `OnQuota.ShutFor` shuts for `valve.quotaShutMs` (an integer >= 1, required with this mode and refused with any other), and both then let probes through like any other shut. `OnQuota.ShutUntilResumed` keeps the breaker open until `CareControl.resume` is called (RS-49), with no half-open probe. While a breaker is open because of quota, its `ValveShutError` carries `forcedBy: 'quota'`, and its fallback trigger is `'quota'`, not `'valve-shut'`. So neither the failing call nor the calls rejected afterwards run a fallback unless `planB.on` lists `'quota'`. The engine emits `quota.used-up` once per quota failure and `valve.forced-shut` once per transition. The library ships no provider-specific rule: only an app classifier can produce `'quota'`. | Given an app classifier that maps a 429 with body `{ reason: 'quota' }` to `'quota'`. When one call fails and a second call follows. Then there is no retry, the breaker for that key is open, the second call fails with `ValveShutError { forcedBy: 'quota' }` after 0 dependency calls, a fallback configured with the default `on` runs for neither call, and exactly one `quota.used-up` and one `valve.forced-shut` are emitted. Given `onQuota: OnQuota.ShutFor` and `quotaShutMs: 5000`. Then the breaker refuses calls for 5000 ms and then lets a probe through. Given `onQuota: OnQuota.ShutUntilResumed`. Then no probe runs after any amount of clock time, until `resume`. Given `quotaShutMs` without `OnQuota.ShutFor`, `OnQuota.ShutFor` without `quotaShutMs`, or an `onQuota` that is not an `OnQuota` value. Then plan resolution throws `CareConfigError`. A test asserts that neither default classifier ever returns `'quota'`. | RU-16a, RU-16b, RU-16c, RU-16d, RU-16e, RU-16f |
| RS-17a (amended) | MUST | **In-process default classifier.** Activators and saga outbound steps use `defaultInProcessClassifier`, which reads errors structurally, never by `instanceof` on a transport class: an `OutboundRestError`-like value (`kind` plus `status`) is classified by the REST table; an error with `retryable: true` is `'transient'` (this covers SPI-429's `IdempotencyStoreUnavailableError` and SPI-433's `SensitiveKeyUnavailableError`); an error with `retryable: false` is `'rejected'`; an inner `OverPaceError` or `LanesFullError` is `'busy'` with its `readyInMs`; an inner `ValveShutError` or `OutOfTimeError` is `'rejected'`, so an outer layer never hammers an open circuit; anything else is `'unknown'`. | Table-driven test over each row. Given an activator method that throws an `OutboundHttpError` with status 503. Then the class is `'transient'`. Given one that throws an inner `ValveShutError`. Then `'rejected'`. | RU-17a |
| RS-17 (amended) | MUST | **429, breaker and quota.** With the defaults, `'busy'` is retried (honouring `Retry-After`) and is **not** a breaker failure. `'transient'` is retried and is a breaker failure. `'quota'` follows RS-16. `'rejected'` and `'unknown'` are neither retried nor recorded. The full matrix is in section 5.3. | Given 20 consecutive 429s and a breaker with a threshold of 50% and `minCalls` 10. When the calls run. Then the breaker stays closed. Given 20 consecutive 503s. Then it opens. | RU-17 |

### 2.5 Circuit breaker

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-18 (amended) | MUST | The breaker has three states: closed, open and half-open. It records **each attempt**, not each call, whose class is in `countOn` (default `['transient']`). Successes are recorded too. It opens when, over the window (`count` of the last N outcomes, or `time` over the last N ms), at least `minCalls` outcomes were recorded and the failure rate is `>= failPercent`%. After `shutMs` it goes half-open. | Given defaults (50%, minimum 10, count window 20). When 5 successes are followed by 5 transient failures. Then it opens on the 10th outcome. After `shutMs` it is half-open. | RU-18a, RU-18b |
| RS-19 (amended) | MUST | In half-open state at most `probes` probe attempts are in flight. Other attempts get `ValveShutError` at once. A probe that succeeds closes the breaker once all `probes` probes have succeeded. Any probe failure that is recorded re-opens it for `shutMs`. A probe whose class is not recorded, or that never reaches the dependency (rate limited after admission, cut by the deadline, aborted), frees its probe slot and leaves the state unchanged. | Given half-open, `probes: 1` and two concurrent calls. When the probe is still in flight. Then the second call fails with `ValveShutError`. When the probe succeeds. Then the breaker is closed. | RU-19 |
| RS-20 (amended) | MUST | The breaker key is `valve.key(ctx)`. The default key is the binding name. A key must be a non-empty string of at most 200 UTF-16 code units. A key function that throws or returns an invalid value fails the call with `CareKeyError` before any attempt, and the dependency is not called. Breakers are kept per key in an LRU map bounded by `maxKeys` (default 1000). Only closed breakers with no in-flight probe are evicted. When the map is full and every entry is open or probing, the new key's call runs with an **unstored** closed breaker that records nothing (the map never grows past `maxKeys`), and a `valve.keys-full` event is emitted at most once per minute per binding. | Given `maxKeys: 2`, two keys, one of them open. When a third key arrives. Then the closed key is evicted and the open one is kept. Given `maxKeys: 2` and two open keys. When a third key arrives. Then its call runs, the map size stays 2, and one `valve.keys-full` event is emitted. Given a key function that throws. Then the call fails with `CareKeyError` and the fetch count is 0. | RU-20a, RU-20b |

### 2.6 Bulkhead and rate limiter

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-21 (amended) | MUST | A bulkhead allows at most `count` calls in flight per edge and binding: a bulkhead inherited from a module default is a separate instance for each binding, never one shared pool. Up to `waitlist` more (default 0) wait in FIFO order for at most `waitlistMs`, capped by the remaining deadline. Others fail at once with `LanesFullError`. The slot is held across all attempts of a call and released in `finally`, when the engine returns. | Given `count: 1, waitlist: 1, waitlistMs: 50`. When 3 calls arrive together. Then call 3 fails at once with `LanesFullError`, and call 2 waits; if call 1 holds the slot past 50 ms, call 2 fails with `LanesFullError` (reason `waitlist-expired`). | RU-21 |
| RS-22 (amended) | MUST | The rate limiter is a token bucket with `perSecond` (> 0), `burst` (default `ceil(perSecond)`) and an optional `key`. **Each attempt** takes one token. With no token, the attempt waits up to `waitMs` (default 0), capped by the remaining deadline, or fails with `OverPaceError`, whose `readyInMs` is the time until the next token. Local state uses a monotonic clock (`performance.now()`), never `Date.now()`. Local buckets are kept per key in an LRU map bounded by `pace.maxKeys` (default 1000). An evicted key's bucket restarts full (R5). A key function that throws or returns an invalid key fails the call with `CareKeyError`, as in RS-20. | Given `perSecond: 2, burst: 2`. When 3 attempts run at t=0. Then the third fails with `OverPaceError` and `readyInMs` 500. Given a retry policy. Then the retries take tokens. Given `maxKeys: 2` and a third key. Then the map size stays 2. | RU-22a, RU-22b |
| RS-23 (amended) | MUST | `pace.state` and `valve.state` accept a `CareStatePort` for state shared between pods. The reference adapter `redisCareState(evalScript)` takes a script-evaluation function from the app and has no npm import. The bucket refill and take are one atomic Lua script that uses Redis server time (`TIME`), so pod clock skew does not matter. The shared breaker is an **open marker** (`open until T`, with a TTL) plus a **half-open probe lease** (`SET NX PX`). Failure counting stays per pod (D11). Each pod reads the shared marker of a key at most once per `syncMs` and caches the answer, so the shared breaker costs at most one read per key per `syncMs`, plus one write per transition. A pod that saw a marker treats the key as half-open once it expires, and probes only while it holds the lease. | Against Redis (`ESTELA_REDIS_URL`): two engines sharing a key and a limit of 5 per second take exactly 5 tokens in total within a second. When pod A opens the breaker, pod B rejects within `syncMs`. Only one pod probes during half-open. | RE-04, RE-05 |
| RS-24 (amended) | MUST | **D-REDIS-DOWN, limiter and breaker.** A state-port call waits at most `min(sharedStateWaitMs, remaining deadline)`. When a state-port call throws or takes longer than `sharedStateWaitMs` (default 100, provisional, OQ-3), the engine moves that binding to **degraded local state**. The rate limiter then uses a local bucket of `soloPerSecond`, whose default is `perSecond / replicas` and `replicas` defaults to 1. It is **never unlimited**. The breaker uses only local state. One `shared-state.lost` event and one warn line are emitted per transition. While degraded, the port is probed at most once per `sharedStateCheckMs` (default 5000). When a probe succeeds, the binding switches back, and `shared-state.back` is emitted. Each call is decided by exactly one source, local or shared, and never by both. | Given a `MemoryCareState` switched `down()`, `perSecond: 4`, `burst: 4`, `replicas: 2` and `waitMs: 0`. When 10 calls arrive at t=0. Then exactly 2 are admitted (degraded rate 2/s, burst `floor(4 / 2)` = 2), 8 fail with `OverPaceError`, none fails with a port error, and exactly one `shared-state.lost` event is emitted. When 10 more arrive at t=1000. Then exactly 2 are admitted. When the port comes back `up()`, the next probe emits `shared-state.back`. Given a port that hangs and 50 concurrent calls. Then each waits at most `sharedStateWaitMs` and one `shared-state.lost` is emitted. | RU-24a, RU-24b |

### 2.7 Fallback

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-25 (amended) | MUST | `planB` has exactly one of `value(error, ctx)` or `channel` (send the original message to that channel and use its reply, request/reply through `ReplyGateway`). It runs only when the final failure's trigger is in `planB.on`. The default `on` is `['transient', 'busy', 'valve-shut', 'lanes-full', 'over-pace', 'out-of-time']`. It never runs by default for `'rejected'`, `'quota'` or `'unknown'`. When a fallback runs, the engine emits `plan-b.used` and the result is marked `planB: true`. | Given an open breaker and a value fallback. When the call runs. Then it resolves with the value, the fetch count is 0, and one `plan-b.used` event is emitted. Given a 400. Then the fallback does not run and the 400 propagates. | RU-25a, RU-25b |
| RS-26 (amended) | MUST | **Failing fallback.** A fallback that throws (or a channel fallback that times out) fails the call with `PlanBFailedError`. Its `cause` is the fallback's error and `original` is the failure that triggered it. The engine emits `plan-b.failed`. The breaker records nothing for the fallback. | Given an open breaker and a fallback that throws `X`. When the call runs. Then it rejects with `PlanBFailedError`, with `cause === X` and `original` set to the `ValveShutError`. | RU-26 |
| RS-27 (amended) | MUST | **Fallback and idempotency (degraded mark).** A result built while any non-cacheable fallback ran is **degraded**, and a degraded result is never stored as the completed result of an Estela idempotency claim (inbound, activator or flow), whatever `onDuplicate` or the SPI-433 `storeMode` says. Mechanism: the activator wrapper, the flow executor and the inbound interceptor open a `CareScope` for each message they handle, built from that message's headers (AGENTS.md invariant 7). An executor that returns `planB: true` sets the plan B mark on the current scope (`CareScope.markPlanB()`). The activator wrapper then settles its own claim without storing the result and sets the reply message header `planB: true` (`PLAN_B_HEADER`). `ReplyGateway` hands the reply headers to the inbound interceptor through an internal method, and the interceptor settles its claim the same way. To settle without storing, the claim is released when the store supports `release`, and otherwise marked failed, so a later duplicate is never answered with a degraded value. `planB.cacheable: true` opts out of the mark. **(amended)** In flows, a `jump` that receives a reply whose headers carry `degraded: true` marks the flow scope too, and flow step claims settle like the flow claim (RS-64). | Given an inbound endpoint with `onDuplicate: 'replay'` whose activator calls an outbound binding that falls back. When the same key is sent twice. Then the second request runs the activator again, the fallback value is not replayed, and neither the activator claim nor the inbound claim holds a `completed` record. Given `cacheable: true`. Then the second request is replayed. | RE-06, RU-27 |

### 2.8 Retry budget (amplification control)

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-28 (amended) | MUST | **Which layer retries.** Along any call path, the **outermost** layer that may retry owns the retries. Every layer inside it, in-process or in another process, makes single attempts. The **retry budget** carries this rule: a count of retries that the layers handling a request may still spend. | Given process A with outbound care `tries: { max: 3 }`, calling process B whose own outbound care has `tries: { max: 3 }`, calling a failing C. When the call runs. Then C receives at most 3 calls, not 9. | RE-03 |
| RS-29 (amended) | MUST | The budget is carried as message header `triesLeft` (an integer) and on the wire as `x-tries-left`, both in HTTP headers and in gRPC metadata. Within one async chain it is also kept in an `AsyncLocalStorage` scope (`CareScope`). The shared header mappers (`adapters/header-mapper.ts`) are **not** changed, so `bindGrpcOut`, Rabbit and every untouched path keep their 0.9.0 wire headers. Instead, the inbound interceptor reads the raw `x-tries-left` header and sets `triesLeft` on the message, and only when `forRoot({ care })` is configured. Rabbit inbound does not read it (SPI-434). Following AGENTS.md invariant 7, the activator wrapper, the flow executor and outbound channel bindings rebuild the scope from `msg.headers.triesLeft` at every dispatch, and never trust an ambient scope across a channel hop. While a scope with a budget is active, a message created by `OutboundRestGateway.request` or by `ChannelRegistry.send` gets that budget as `triesLeft` when it has none, the same way `request` inherits the trace (`outbound-rest.gateway.ts:115-126`). | Given an inbound request with `x-tries-left: 0` and a module with `care`. When an activator calls `request()`. Then the outbound plan sees budget 0 and makes 1 attempt. Given the same activator sending to a `queue` channel whose consumer calls a retrying binding. Then that binding also sees budget 0. Without `forRoot({ care })`, the header is ignored and no message gets a `triesLeft` header. | RU-29a, RU-29b, RE-02 |
| RS-30 (amended) | MUST | **Claim and forward.** A layer whose effective number of extra tries is `min(tries.max - 1, triesLeft ?? Infinity)`, and that number is > 0, **keeps** them: each try sends `x-tries-left: 0` downstream and runs nested executors in a scope with budget 0. A layer with no retries forwards the incoming budget unchanged, or sends nothing when there is none. `tries.triesLeft: 'forward'` lets such a layer forward instead of keep (`'keep'` is the default). This permits amplification and is documented as such. | Given no tries left and `tries.max: 3`. When the call runs. Then each attempt carries `x-tries-left: 0`. Given an activator with no retry and an inbound budget of 2. Then its inner outbound sees 2 and may retry twice. | RU-30a, RU-30b |
| RS-31 (amended) | MUST | Budget values that are not a non-negative integer (`-1`, `1.5`, `abc`, empty) are treated as absent and counted in the metric `estela_care_tries_left_invalid_total`. Values above 20 (`MAX_RETRY_ATTEMPTS`) are capped at 20. `forRoot({ care: { triesLeft: { initial } } })` MAY set a budget for requests that arrive without one. The header is client-controlled: it can only lower the number of retries (`min(maxAttempts - 1, budget)`), never raise it. | Given `x-tries-left: abc`. When parsed. Then the budget is undefined and the counter is +1. Given `999`. Then the budget is 20. | RU-31 |
| RS-32 (amended) | SHOULD | When care with `tries.max > 1` gets 0 effective extra tries because of tries left, it emits one `try.held` event per call. | Given tries left 0 and `tries.max: 3`. When the call fails. Then 1 attempt is made and 1 `try.held` event is emitted. | RU-32 |

### 2.9 Where policies apply

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-33 (amended) | MUST | Outbound REST accepts `care` on a binding, on `outbound.rest.defaults`, on `@OutboundRest` and on ad-hoc `request()` options. Ad-hoc options are planned per options object (`outbound-rest.gateway.ts:105-113`), so they cannot hold state between calls reliably: an ad-hoc `care` that sets `valve`, `lanes` or `pace` is refused with `CareConfigError` on the first call, and those primitives inherited from the module default are not applied to ad-hoc calls (one warn line per ad-hoc `name`). A per-target or per-call `timeoutMs` still overrides `eachTryMs`. The request is still built once. The executor wraps only the attempt (send and receive). `mapError` still runs once, after the policy's final outcome, and receives `OutboundRestError \| CareError`. A fallback value is not passed to `response` or `mapError`; it is the reply. One hop line is written per call, as today. | Given `care: { tries: { max: 3 }, valve: {...} }` on a binding. When the call fails 3 times with 503. Then `mapError` is called once with the third `OutboundHttpError`, and exactly one `hopStart`/`hopEnd` pair is logged. | RE-01 |
| RS-34 (amended) | MUST | `timeoutMs` and `retry` on outbound REST are aliases with the identical semantics of section 1. | The existing outbound spec files pass unmodified. An equivalence test runs the same scripted failures through `retry: {...}` and through its alias plan, and asserts the same attempts, delays, errors and headers, with no `x-tries-left` header. | RU-34, existing `outbound.spec.ts` |
| RS-35 (amended) | MUST | Setting both a legacy option and its `care` counterpart on the **same layer** (`retry` with `care.tries`, or `timeoutMs` with `care.patience.eachTryMs`) throws `CareConfigError` when the binding is declared. Across layers, normal precedence applies, and the higher layer wins whichever spelling it uses. | Given a binding with `retry: {}` and `care: { tries: {} }`. When it is bound. Then `bind()` throws. | RU-35 |
| RS-36 (amended) | MUST | `@ServiceActivator(channel, { care })` wraps the method call: the retry, the timeout and the rest run between `idem.begin` and `idem.complete` (`activator-wrapper.ts:85-107`), so a retry never re-claims. A retry needs `tries.idempotent: true` or a message `idempotencyKey`; otherwise `maxAttempts > 1` is reduced to 1 at run time and `try.held` is emitted. The attempt's `AbortSignal` is available to the method through `currentTrySignal()`. A method that ignores the signal keeps running after a timeout (R4). Errors are classified by `defaultInProcessClassifier` (RS-17a) unless the policy sets `classify`. **(amended)** `care` accepts a `CareRef` (RS-71), and `ChannelSpec.care` of the activator's channel is its L2 default (RS-56). | Given `retry: { maxAttempts: 2 }` and no key. When the method throws an error with `retryable: true`. Then it runs once. Given `idempotent: true`. Then it runs twice and `idem.begin` is called once. | RU-36a, RU-36b |
| RS-37 (amended) | MUST | **Inbound load shedding.** `InboundSpec.care` and `InboundDefaults.care` accept only `lanes` and `pace`. Any other primitive, or any inbound resilience on `@InboundRabbit`, throws `CareConfigError` at boot. Tokens and slots are taken in `intercept()` **before** `next.handle()` (`inbound.interceptor.ts:104-120`), which is after guards and before pipes and the handler. Shedding therefore happens before the idempotency claim (`:131`), and a shed request leaves no claim. The slot is held until the reply observable completes, errors or is unsubscribed. The shed key function receives raw headers from the strategy's new optional `rawHeaders(context)` method, because `extract` needs the handler result. A strategy without that method gives `{}`. A shed request throws `InboundBusyError`, which extends Nest `HttpException` with status **429** and carries `grpcCode = 8` (`RESOURCE_EXHAUSTED`). For HTTP, before throwing, the interceptor sets `Retry-After` (seconds, rounded up) on the platform response object (`setHeader` on Express, `header` on Fastify) when `readyInMs` is known. If there is no response object, the header is omitted. The gRPC status is mapped by SPI-431's status mapper, or by an app exception filter until SPI-431 lands. **(amended)** Both accept an `InboundCareRef`; a profile used here must hold only `lanes` and `pace`. `ChannelSpec.care` and `care.defaults.inbound` never apply to inbound (RS-54, RS-56). | Given `@InboundRest({ ..., care: { pace: { perSecond: 1, burst: 1 } } })` with idempotency. When two requests with different keys arrive at once. Then the second gets HTTP 429 with `Retry-After: 1`, and `store.get` for its key returns `undefined`. | RE-02, RU-37 |
| RS-38 (amended) | MUST | A saga outbound step accepts `care` on `.outbound(name, run, { care })`. `planB` is refused when the saga is defined (`SagaDefinitionError`), because it would hide a failure and skip compensation. Retry with `maxAttempts > 1` needs `tries.idempotent: true`, otherwise `SagaDefinitionError`. Compensation runs only after the policy gives up. The saga unit-of-work `RetryPolicy` is unaffected. The whole policy is one `outbound:<name>` hop. Outbound retries take no `ctx` checkpoint: a change that a failed attempt made to `ctx` stays visible to the next attempt and to the compensation (documented; the step must be written to tolerate it). **(amended)** `care` accepts a `CareRef`; a `planB` resolved from the step's own reference raises `SagaDefinitionError`, and a `planB` inherited from `care.defaults['saga-outbound']` is dropped with one boot warning (RS-59 rule). | Given an outbound step with `maxAttempts: 3, idempotent: true` that fails 3 times. When the saga runs. Then the step runs 3 times, then the compensation runs once, then the step's last error is rethrown. Given `planB` on a saga outbound step. Then `.outbound()` throws `SagaDefinitionError`. | RU-38a, RU-38b |
| RS-39 (amended) | MUST | The engine is transport-agnostic. `CareExecutor.execute(ctx, attemptFn)` takes a `CareEdgeAdapter` that supplies the default classifier, `repeatable(ctx)`, the timeout error, the extraction of `readyInMs`, and the injection of the budget header. No REST-, gRPC- or SDK-specific code lives in `src/resilience/` except the two pure default classifiers. SPI-430 and SPI-436 MUST use this contract instead of their own retry loops. | Given a fake adapter. When the executor runs. Then every primitive works without any outbound module loaded (the unit test imports only `src/resilience`). | RU-39 |

### 2.10 Observability and sensitive data

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-40 (amended) | MUST | Every state change and engine decision publishes a `CareEvent` to the pubsub channel `estela.care.events` (created when `forRoot({ care })` is set; `events.channel: false` turns it off) and to an optional `events.onEvent` hook. Publishing is fire-and-forget: it is never awaited on the call path, and its errors are swallowed and logged at warn at most once per minute. Events raised while a message from the events channel is being handled are dropped, which prevents event loops. | Given a subscriber that throws. When a breaker opens. Then the call outcome is unchanged and 1 warn line is logged. Given an activator on `estela.care.events` with a failing policy. Then no event is published from inside it. | RU-40a, RU-40b |
| RS-41 (amended) | MUST | `CareMetricsPort` (`counter`, `histogram`, `gauge`) receives the metrics of section 7.2. The default is a no-op. Labels are limited to `edge`, `binding`, `outcome`, `class` and `reason`. **No key label by default.** A port that throws is swallowed in the same way as RS-40. | Given a recording port. When a call is retried once and succeeds. Then `estela_care_tries_total` is +2 and `estela_care_extra_tries_total` is +1, and no label value contains the key. | RU-41 |
| RS-42 (amended) | MUST | The graph shows a compact policy summary on each annotated edge: `GraphOutboundRef.care`, `GraphInboundRef.care`, the activator label, and the Mermaid edge label. Examples: `patience 2s · total 5s · tries x3 · valve · lanes · pace · plan-b`. Only timeouts and the number of attempts are shown as numbers. No thresholds, limits, key functions or URLs appear. An edge with no care has no `care` field. Exposing the graph is governed by SPI-432. **(amended)** Flow steps and targets carry the annotations of RS-66; the meaning of `care` on flow targets is open (OQ-13). | Given a binding with every part. When the graph snapshot is taken. Then `care` equals the expected string. Given a binding with no care. Then the JSON has no `care` key, which matches today's snapshot. | RU-42 |
| RS-43 (amended) | MUST | **Keys in sinks (D-PHONE).** A breaker or rate-limit key returned by a custom `key` function never appears raw in an event, metric, log line, error message, graph or state-port key. Events carry `keyLabel` only when the module `keyLabel(key, ctx)` function is configured. The app supplies it, for example the SPI-433 masker in `'hash'` mode (salted HMAC). Otherwise `keyLabel` is omitted. State-port keys are `estela:care:<part>:<binding>` for the default key (the binding name, not personal) and `estela:care:<part>:<binding>:<keyHasher(key)>` for a custom key. A custom `key` combined with a shared `state` port and no module `keyHasher` is refused at boot with `CareConfigError`. There is **no unsalted digest fallback**, which matches SD-15. A `keyHasher` or `keyLabel` that throws, or returns an empty string, a string over 128 characters, or characters outside `[A-Za-z0-9:_.-]`, fails the call with `CareKeyError` before any attempt. | Given a key `+50255501234`, local state and no `keyLabel`. When a breaker opens. Then the event, the log line, the metric labels and the error message do not contain the string `50255501234`. Given a custom key, a shared state port and no `keyHasher`. Then boot fails naming `valve.state`. Given a `keyHasher` that returns an HMAC. Then the Redis key ends with that HMAC and contains no digit run from the number. | RU-43a, RU-43b, RU-43c |
| RS-44 (amended) | MUST | The messages of `CareError` subclasses carry only the binding, the kind and the attempt count (for example `circuit open for outbound rest 'orders.http'`). They never carry a URL query, a key, a header or a payload. The original error is kept in `cause`. | Each error class has a message snapshot test with a URL query and a key in the context; neither appears in the message. | RU-44 |
| RS-45 (amended) | SHOULD | Engine log lines go through Nest `Logger('EstelaCare')`: `valve.shut`, `valve.forced-shut` and `shared-state.lost` at warn; `valve.flowing` and `shared-state.back` at log; per-attempt retry lines at debug only. No line is written per successful call. | Given a breaker that opens and closes. When it runs. Then there is one warn line and one log line, and no other line. | RU-45 |

### 2.11 Errors and testing helpers

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-46 (amended) | MUST | `CareError` and its subclasses carry a `Symbol.for('@estela/nest.CareError')` brand and a `Symbol.hasInstance` fallback, following the same rule as `ConcurrencyError`: the brand applies only to the base class and to classes with their own static `errorKind`. As a result, `instanceof` holds across the `.` and `./testing` CJS bundles. | `test/dist-identity.spec.ts` is extended: an error from the testing bundle passes `instanceof` against the main bundle's class. | RU-46 (dist) |
| RS-47 (amended) | MUST | `@estela/nest/testing` exports `manualCareClock()` (with `advance(ms)`, monotonic and wall time), `MemoryCareState` (with `down()`, `up()`, `slow(ms)` and `failNext(n)`), and `collectCareEvents(module)`. Every timer of the engine goes through the injected clock. | Every RU test in section 10 runs without real timers (`jest.useFakeTimers` is not needed). | RU-47 |

### 2.12 Operational control and key enforcement

| ID | Level | Requirement | Acceptance | Test |
|---|---|---|---|---|
| RS-48 (amended) | MUST | **`tries.requireIdempotencyKey`** (default false) on an outbound REST binding, an activator or a saga outbound step. When true, a non-safe operation (REST: a method other than GET, HEAD, OPTIONS; activator and saga: always) without an idempotency key fails before any attempt with `CareKeyError` (reason `idempotency-key-required`), and the dependency is not called. Declaring it on a REST binding with `idempotency: false` is refused at boot. It is independent of `maxAttempts`: it also applies to a single attempt. | Given a POST binding with `requireIdempotencyKey: true` and no key resolver. When a message without `idempotencyKey` is sent. Then the call fails with `CareKeyError` and the fetch count is 0. Given the same binding with `idempotency: false`. Then `bind()` throws `CareConfigError`. | RU-48 |
| RS-49 (amended) | MUST | `CareControl` (an injectable, present when `forRoot({ care })` is set) exposes `valveState(binding, key?)` returning a `ValveStateView` (`'flowing' \| 'shut' \| 'probing'` plus `forcedBy`) or `undefined`, and `resume(binding, key?)`, which closes the local breaker, clears the shared marker when shared state is configured, and emits `valve.flowing`. Keys are passed raw by the app and never logged (RS-43). Unknown bindings or keys resolve to `undefined` or a no-op, never an error. | Given a breaker forced open with `onQuota: OnQuota.ShutUntilResumed`. When `resume` is called. Then the next call reaches the dependency, `valveState` is `'flowing'`, and one `valve.flowing` event is emitted. | RU-49 |
| RS-50 (amended) | SHOULD | **Replica findings.** (amended: the findings also name flow step subjects, `flow:<flow>#<stepId>` for `handle` and `flow:<flow>#<stepId>:<channel>` for a send or jump target, that hold a local limiter or breaker, RS-66.) When SPI-429's replica guard (`assessReplicaSafety`, `MR-` spec) is present and the effective mode is `multi`, the resilience module contributes these warning findings: `PROCESS_LOCAL_RATE_LIMIT` for a rate limiter with `state: 'local'`; `PROCESS_LOCAL_BREAKER` for a breaker with `state: 'local'`; and `REPLICAS_HINT_DEFAULT` for a shared rate limiter whose `replicas` is 1. If SPI-429 has not merged when this ticket merges, RS-50 is deferred to a follow-up, and the deferral is recorded in the PR. | Given `ESTELA_REPLICAS=multi` and a binding with a local rate limiter. When the app boots. Then the guard logs one `PROCESS_LOCAL_RATE_LIMIT` warning naming the binding. | RU-50 |

### 2.13 Flow DSL and channel integration

**Goal.** Estela must let a flow author give each flow, each step and each channel the resilience parameters of this spec, so that a flow, not only an outbound binding, can bound, retry, shed and fall back. This section applies the **shared ESTELA flow parameter model** (the proposal shared by SPI-433, SPI-429, SPI-445 and the KA- adoption spec; location: OQ-16) to resilience. It uses that model's names and shapes exactly: levels L0..L5, `CareRef`, `CareProfile`, `CareModuleOptions.policies` and `.defaults`, the edge kinds `'flow-handle' | 'flow-jump' | 'flow-send'`, `FlowOptions`, `StepCommonOptions`, `FlowTarget`, `FlowDest`, `ChannelSpec.care`, `FlowParameterResolver` and its finding codes. Sensitive-data options (`sensitive`, `apply: 'mask-payload'`) belong to SPI-433, and step and store idempotency options (`StepIdempotencyOptions`, `StoreRef`, `stores`) belong to SPI-429. They appear here only where resilience depends on them.

**Ground truth.** None of the flow DSL methods accepts a resilience option today, and `IntegrationFlow.from(source)` takes no options (`flow/integration-flow.ts:41-99`). The only flow-level bound is the jump wait (`jump.step.ts:13,36`). Section 0.1 lists the verified behaviour this section builds on. Every addition below is an optional trailing parameter, and with none of them set a flow behaves exactly as in 0.9.0 (RS-70).

**Levels used by resilience** (highest wins; the full table is in the shared model, section 1.1):

| Level | Resilience is written in |
|---|---|
| L5 call | `OutboundRestCallOptions.care` (RS-68). SDK and gRPC call options: SPI-436 and SPI-430. A flow step has no call level. |
| L4 step or endpoint | a DSL step option; one `fanoutTo`/`jumpTo` target (`FlowTarget.care`); `jump(channel, { care })`; `@ServiceActivator`; `@InboundRest`/`@InboundGrpc` spec; `OutboundRestBinding`/`@OutboundRest`; ad-hoc `request()` options; `bindGrpcOut` options; a saga `.outbound` step |
| L3 flow | `IntegrationFlow.from(source, { care: { handle?, jump?, send? } })` |
| L2 channel | `ChannelSpec.care` of the **destination** channel for send and jump steps, and of the activator's own channel |
| L1 module | `forRoot({ care: { profiles, defaults } })`, `outbound.rest.defaults`, `InboundDefaults.care` |
| L0 built-in | RS-01: no primitive, one direct attempt (plus the 0.9.0 jump wait, RS-62) |

**Resilience per DSL method** (the resilience column of the shared model, section 3.1):

| DSL method | Edge kind | `care` | Allowed primitives |
|---|---|---|---|
| `filter`, `transform`, `headers` (D37), `reply` | none | refused (RS-57) | none |
| `wireTap` | none | **never** (RS-58) | none |
| `handle(fn, opts?)` | `flow-handle` | yes | all; `planB` `value` or `channel` |
| `jump(channel, { wait?, timeoutMs?, care?, sensitive?, id? })`, `jumpTo(dests, opts?)` | `flow-jump` | yes, per target | all; `planB` only on awaited targets |
| `to(channel, opts?)` | `flow-send` | yes | all except `planB`; `to` accepts only `planB: { channel }` |
| `publish(channel, routingKey?, opts?)` / `publish(channel, opts)`, `fanoutTo(dests, opts?)`, `route(fn, opts?)` | `flow-send` | yes, per target | all except `planB` |

| ID | Level | Requirement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| RS-51 (amended) | MUST | **Levels.** Every resilience subject resolves its policy over the levels L0..L5 of the table above. For a send or jump step, L2 is the **destination** channel's `ChannelSpec.care`. For an activator, it is its own channel. A flow step has no L5. The remaining deadline (RS-69) and the incoming retry budget (RS-29..31) are **runtime caps**, not levels: they only narrow a resolved value and never widen it. | Given `defaults: { 'flow-send': 'p1' }` where `p1` is `{ timeout: { eachTryMs: 1000 }, retry: { maxAttempts: 2 } }`, a channel `c` with `care: { tries: { max: 4, idempotent: true } }`, a flow with `send: { timeout: { eachTryMs: 500 } }`, and a step `to('c', { care: { lanes: { count: 1 } } })`. When the plan is resolved. Then it has `eachTryMs` 500 (L3), retry x4 (L2), a bulkhead (L4) and no breaker. Given an incoming budget of 0. Then the step makes 1 attempt and the resolved plan still shows retry x4 in the graph. | RU-51 |
| RS-52 (amended) | MUST | **Merge.** Across levels, merging is **per-primitive replace**: the highest level that sets `patience`, `tries`, `valve`, `lanes`, `pace`, `planB` or `classify` owns that key whole, and the other primitives keep inheriting. There is no field-level merge across levels (RS-04, amended). Inside one reference, `{ use: 'name', ...inline }` deep-merges the inline fields over the named profile's primitive **once**, field by field; arrays and functions replace, and `false` replaces. `care: false` means no care at this level and below: one direct try (for a jump, still bounded by the 0.9.0 wait, RS-62). `tries: false` disables only that part. | Given profile `p` = `{ tries: { max: 5, spacing: 100 }, patience: { eachTryMs: 2000 } }` and a step `{ use: 'p', tries: { spacing: 50 } }`. When resolved. Then `tries` is 5 tries with 50 ms spacing and `eachTryMs` 2000. Given a flow default `send: 'p'` and a step `{ retry: { backoff: 50 } }` (no `use`). Then the step's retry is `{ backoff: 50 }` with the built-in 3 attempts, and `eachTryMs` 2000 still comes from the flow. Given a step `care: false` under that flow default. Then one direct attempt. | RU-52 |
| RS-53 (amended) | MUST | **Named profiles.** `CareModuleOptions.profiles` maps a `ProfileName` (`^[a-z0-9][a-z0-9._-]{0,63}$`) to a `CareProfile`. `extends` is single inheritance resolved at boot with the same deep-merge-once rule (parent first, child over it). A cycle fails boot with `PROFILE_CYCLE`, a chain of more than 8 `extends` hops with `PROFILE_DEPTH` (amended: counted in hops as SD-48 counts them, so 10 profiles fail and 9 boot), an unknown name with `UNKNOWN_PROFILE`, and a name outside the grammar with `CareConfigError` at `care.profiles.<name>`. A profile is validated with the rules of section 5.6 each time it is resolved onto a subject, because the edge restrictions depend on the edge. A profile is a **template, never an instance**: every subject that resolves it gets its own breaker, bulkhead and buckets (the rule RS-21 already sets for module defaults). Only profile names reach logs, errors and the graph, never profile values. | Given `a extends b` and `b extends a`. When the module boots. Then boot fails with one finding `PROFILE_CYCLE` naming both. Given a chain of 10 profiles (9 hops). Then `PROFILE_DEPTH`. Given a chain of 9 profiles (8 hops). Then it boots. Given two bindings using `http-guarded` and only one failing dependency. Then only that binding's breaker opens. | RU-53a, RU-53b |
| RS-54 (amended) | MUST | **Module defaults per edge kind.** `CareModuleOptions.defaults` (`Partial<Record<CareEdge, CareRef>>`) is the L1 policy of every subject of that edge kind. `CareEdge` gains `'flow-handle'`, `'flow-jump'` and `'flow-send'`. `defaults.inbound` is refused at boot (`CareConfigError`, path `care.defaults.inbound`), because inbound defaults come only from `InboundDefaults.care` (RS-37). `defaults['outbound-rest']` together with `outbound.rest.defaults.care` is refused at boot, because both are L1 for one edge (OQ-14). `defaults['outbound-rest']` setting `retry` or `patience.eachTryMs` while `outbound.rest.defaults` sets the legacy `retry` or `timeoutMs` is `LEGACY_AND_NEW_SAME_LAYER` (RS-35). Without `defaults`, no subject gets a module policy, as before. | Given `defaults: { 'flow-jump': 'jump-sla' }`. When a flow has a `jump` and a `to`. Then only the jump gets `jump-sla`. Given `defaults: { inbound: {...} }`. Then boot fails naming `care.defaults.inbound`. | RU-54 |
| RS-55 (amended) | MUST | **Flow level (L3).** `IntegrationFlow.from(source, options?: FlowOptions)`. `FlowOptions.care` is split by step family: `handle` applies to `handle` steps, `jump` to `jump` and `jumpTo`, and `send` to `to`, `publish`, `route` and `fanoutTo`. A flow default never applies to `wireTap`, `filter`, `transform` or `reply`. `FlowDefinition` is unchanged; the options travel inside the built flow (`BuiltFlow.options`). | Given `from('in', { care: { send: 'p' } })` with `wireTap('tap')`, `transform(f)` and `to('out')`. When the graph is taken. Then only the `to` step shows a policy. | RU-55 |
| RS-56 (amended) | MUST | **Channel level (L2).** `ChannelSpec.care` is the default for (a) send and jump steps whose **destination** is that channel and (b) activators **on** that channel. It never applies to inbound endpoints (RS-37), to a `wireTap` toward that channel (RS-58), or to `handle` steps of flows whose source is that channel (OQ-15). When (a) and (b) both apply with a retry, boot logs `TRIES_STACKED` (RS-60), and the retry budget bounds the product at run time (RS-65). | Given channel `c` with `care: { tries: { max: 3, idempotent: true } }`, a flow step `to('c')`, an activator on `c` that always fails with `retryable: true`, and `forRoot({ care })`. When the module boots. Then one `TRIES_STACKED` warning names both subjects. When one message runs. Then the activator method runs 3 times in total, not 9. | RU-56 |
| RS-57 (amended) | MUST | **Step options.** The DSL signatures of section 3.10 are optional trailing parameters. `StepCommonOptions.id` is the stable step id, `<kind>#<index>` by default (`index` is the step's 0-based position in the flow). It must be unique per flow, else `FlowDefinitionError` with `DUPLICATE_STEP_ID`. `care` is accepted only on `handle`, `jump`, `jumpTo`, `fanoutTo`, `publish`, `route` and `to`. A `care` option on `filter`, `transform` or `reply` (reachable from JavaScript) fails flow build with `FlowDefinitionError` and code `CARE_PART_NOT_ALLOWED` (OQ-17). `publish(channel, routingKey?, opts?)` and `publish(channel, opts)` are overloads: a string second argument is the routing key. On `fanoutTo` and `jumpTo`, the step option is the L4 policy of every target, and a target's own `FlowTarget.care` replaces it per primitive for that target (target over step inside L4). | Given `jumpTo(['a', { channel: 'b', care: { tries: false } }], { care: 'p' })` where `p` retries. When resolved. Then `a` retries and `b` does not, and both keep `p`'s timeout. Given two steps with `id: 'x'`. Then build fails with `DUPLICATE_STEP_ID`. Given `publish('c', { id: 'p1' })`. Then no routing key is set. | RU-57 |
| RS-58 (amended) | MUST | **wireTap never carries resilience** (shared model rule 4.1). The `wireTap` options type has no `care` field. A JavaScript caller that passes one gets `FlowDefinitionError` with `WIRETAP_CARE` when the flow is built. Module, flow and channel defaults skip `wireTap`, including a channel default on the tap channel. The tap stays fire-and-forget and swallows failures (`wire-tap.step.ts:14-17`). The `triesLeft` header is removed from the tap copy, so a tap consumer neither consumes nor forwards the caller's budget. | Given `wireTap('t', { care: {...} } as any)`. When built. Then `FlowDefinitionError(WIRETAP_CARE)`. Given channel `t` with a retry policy and a message with `triesLeft: 2`. Then the tap copy is sent once and has no `triesLeft` header. | RU-58 |
| RS-59 (amended) | MUST | **Allowed primitives per flow edge** (shared model rule 4.6; section 5.5 rows). `flow-handle`: all parts, with a `planB` `value` or `channel` (request/reply, RS-25). `flow-jump`: all primitives, with `planB` only on awaited targets. `flow-send`: every primitive except `planB`, except that `to` accepts `planB: { channel }`, which sends the same hop (reply inherited) to that channel as a **plain send**, not request/reply. A primitive the edge refuses fails boot with `CARE_PART_NOT_ALLOWED` when it was set at L4. When it comes from L1..L3, it is dropped from that subject's plan with one boot warning per subject and primitive. | Given `fanoutTo(['a'], { care: { planB: { value: () => 1 } } })`. When the module boots. Then boot fails with `CARE_PART_NOT_ALLOWED`. Given the same fallback in `defaults['flow-send']`. Then boot succeeds, logs one warning per affected send step, and those steps have no fallback. Given `to('a', { care: { planB: { channel: 'b' } } })` and `a` failing. Then `b` receives the hop with the original `replyChannel`. | RU-59 |
| RS-60 (amended) | MUST | **A flow step retries only under an idempotency key** (shared model rule 4.2). An attempt after the first runs only when (a) the message carries `headers.idempotencyKey` (propagated by `nextHop`, `message.ts:155-185`), (b) the step's `idempotency.key` resolves a non-empty key (SPI-429), or (c) the resolved policy has `tries.idempotent: true`, which is logged at boot and shown as `repeatableBy: 'declared'`. Otherwise `maxAttempts` is reduced to 1 at run time and `try.held` is emitted once per step execution and target. A policy with `tries.requireIdempotencyKey: true` fails before the first attempt instead (RS-48), with 0 sends. Boot warnings, each logged once: `TRIES_WITHOUT_KEY` (`maxAttempts > 1` on a step whose resolved policy has no `tries.idempotent: true`, that has no step `idempotency.key` resolver, and whose flow claim is turned off with `FlowOptions.idempotency: false`; the module `IdempotencyService` always exists in 0.9.0 (`integration.module.ts:150`), so with the flow claim on, a message key is the expected gate and no warning is logged) and `TRIES_STACKED` (a send-step retry toward a channel whose activator or outbound binding also retries). | Given a flow with `idempotency: false` and a `handle` step with retry x3, no key and no `idempotent`. When `fn` fails with `retryable: true`. Then `fn` runs once, one `try.held` is emitted, and boot logged `TRIES_WITHOUT_KEY`. Given the same step in a flow with the default claim. Then no `TRIES_WITHOUT_KEY` is logged. Given the same message with `idempotencyKey`. Then `fn` runs up to 3 times. Given `requireIdempotencyKey: true` and no key. Then the step fails with `CareKeyError` and `fn` is not called. | RU-60a, RU-60b |
| RS-61 (amended) | MUST | **What one attempt is.** `handle`: one call of `fn(payload, msg)` with `currentTrySignal()` set. It runs between the step claim's `begin` and `complete` (SPI-429), so a retry never claims twice. The same input message is passed to every attempt, and Estela does not deep-copy it (R16). Send steps: the hop (`nextHop`) is built **once per target per step execution**, and every attempt sends an identical shallow copy (same `id`, `history`, `idempotencyKey` and `routingKey`), so downstream deduplication sees one logical message. A jump attempt's copy differs only in `replyChannel`, which is that attempt's own `reply.<uuid>` (RS-62), and in `triesLeft` when RS-65 stamps it (D27). Section 5.7 states what an attempt covers per destination kind. `route`: its function runs once per step execution, outside the executor. Its errors fail the flow unclassified, as in 0.9.0, and each returned channel then runs its own attempt loop. Flow hop lines stay one `flowStart`/`flowEnd` pair per flow execution (`flow-executor.ts:88-104`). Per-attempt detail lives only in resilience events. | Given a `to('c')` step with retry x2 and a key, and a direct subscriber that fails once. When the flow runs. Then the subscriber sees two messages with the same `id`, and one `flowStart`/`flowEnd` pair is logged. Given a `route` whose function throws. Then the function ran once and no resilience event is emitted. | RU-61 |
| RS-62 (amended) | MUST | **A jump policy wraps send plus await reply** (shared model rule 4.5). For each awaited target, one attempt: (1) opens a new `reply.<uuid>` channel; (2) sends the hop with that reply; (3) awaits the first reply under the attempt's timeout; (4) in `finally`, cancels the wait and unregisters the channel (`jump.step.ts:56-77`). `totalMs` covers every attempt and backoff. A late reply to an earlier attempt reaches an unregistered channel and is dropped. A target's `timeoutMs` is the **legacy alias** of `care.patience.eachTryMs`, and setting both on one target fails boot with `LEGACY_AND_NEW_SAME_LAYER`. When no level sets `eachTryMs`, a `flow-jump` plan's `eachTryMs` is the 0.9.0 wait (`timeoutMs ?? 10000`). **A jump wait is never unbounded:** when the effective `eachTryMs` is 0 or `timeout` is `false`, the wait is the remaining deadline when `totalMs` is set, else the 0.9.0 wait (`timeoutMs ?? 10000`); otherwise it is `min(eachTryMs, remaining deadline)`. Sibling targets resolve their policies independently and are still joined by `Promise.all` (`:43`). `wait: false` targets run the same attempt loop in the background, refuse `planB`, and report only their **final** failure, once, to `error.channel` with the 0.9.0 envelope (`forget.ts:15-24`). After `onApplicationShutdown` starts, no background attempt starts, and pending backoff sleeps end with the last error. | Given `jump('svc', { care: { patience: { eachTryMs: 100 }, tries: { max: 2, idempotent: true } } })` and a responder that answers attempt 1 after 150 ms and attempt 2 at once. When the flow runs. Then `jumpReplies.svc` is attempt 2's payload, attempt 1's late reply is dropped, and no `reply.*` channel remains registered. Given `jump('svc', { timeoutMs: 50, care: { patience: { eachTryMs: 80 } } })`. Then boot fails. Given `{ timeout: false }` and no deadline. Then the wait is 10000 ms. Given `{ retry: { maxAttempts: 2, idempotent: true } }` with no `timeout` at any level. Then each attempt waits 10000 ms. Given a `wait: false` target failing 3 times under retry x3. Then exactly one `{ fireAndForget: true, channel }` envelope reaches `error.channel`. | RU-62a, RU-62b, RU-62c |
| RS-63 (amended) | MUST | **Flow edge classification and adapters.** The `flow-send` and `flow-jump` adapters classify channel errors **by `name`**, never by `instanceof` (the channel errors set `name = new.target.name`, `channel.ts:37-42`; `JumpTimeoutError` sets it explicitly, `flow-step.ts:55-60`), and pass every other error to `defaultInProcessClassifier` (RS-17a): `JumpTimeoutError` is `'transient'` (flow-jump only); `CapacityExceededError` is `'busy'`; `NoSubscriberError`, `ChannelNotFoundError` and `FanoutCycleError` are `'rejected'`. `flow-handle` uses `defaultInProcessClassifier`. `repeatable(ctx)` is the gate of RS-60 for all three edges. The `flow-jump` adapter's `overdueError` is `JumpTimeoutError(channel, timeoutMs)`, as today. Without this table, every channel error would be `'unknown'` and a flow retry would never fire, because none of them carries `retryable`. | Table-driven test over each row, with a policy that retries `['transient', 'busy']`. Given a full `queue` destination. Then the send is retried after the backoff. Given a `direct` destination without a subscriber. Then one attempt only. | RU-63 |
| RS-64 (amended) | MUST | **Fallback and the degraded mark in flows** (shared model rule 4.3, RS-27). A `handle` fallback value becomes the payload. A `jump` fallback value lands in `headers.jumpReplies[channel]`, and `headers.jumpPlanB[channel]` is set to `true`. When any non-cacheable fallback fires during a flow run, `CareScope.markPlanB()` marks the scope. On a degraded run, the step claim and the flow claim settle as MR-51 (SPI-429) defines: `release` when the store has it, else `fail`, never `complete` (`flow-executor.ts:70-76` completes today), so a redelivery with the same key runs again. (amended) MR-51 owns the settlement; this requirement owns the mark and the headers. A jump reply whose headers carry `planB: true` also marks the flow scope (today the jump keeps only `reply.payload`, `jump.step.ts:72`). On a degraded run, a `reply` step adds `degraded: true` to the reply headers, as the activator wrapper does (RS-27), so a flow reached by a jump or by an inbound request/reply propagates the mark; `reply.step.ts:27-32` builds those headers today and a non-degraded run adds nothing. `planB.cacheable: true` is the only opt-out, and it is logged at boot. | Given a keyed flow whose `jump` falls back. When the same key is delivered twice. Then the flow runs twice, the store holds no `completed` record for `flow:<name>`, and `jumpPlanB.svc` is `true` in the first run. Given a jumped-to activator whose outbound call fell back. Then the jumping flow's claim is released too. Given a jumped-to flow whose `handle` fell back and that ends with `reply()`. Then its reply carries `degraded: true` and the jumping flow's claim is released. Given a flow without fallback. Then its `reply` headers are those of 0.9.0. | RU-64a, RU-64b, RE-08 |
| RS-65 (amended) | MUST | **Retry budget in flows.** When `forRoot({ care })` is set, the flow executor opens a `CareScope` from `msg.headers.triesLeft` for each message (RS-29). A flow step whose effective retries are > 0 and whose `tries.triesLeft` is `'keep'` stamps `triesLeft: 0` on each hop it sends and runs `fn` (for `handle`) in a scope with budget 0. A step with no retries forwards the incoming budget unchanged; `nextHop` already copies it (`message.ts:160-185`). A `wireTap` copy carries no budget (RS-58). Without `forRoot({ care })`, no hop gets a `triesLeft` header. | Given a message with `triesLeft: 2` and a `to('c')` step with retry x3 and a key. When the flow runs. Then the hop to `c` has `triesLeft: 0` and the step makes at most 3 attempts. Given a step without retry. Then the hop has `triesLeft: 2`. | RU-65 |
| RS-66 (amended) | MUST | **Observability of flow edges.** Events and metrics use `binding = flow:<flow>#<stepId>` for `flow-handle` and `flow:<flow>#<stepId>:<channel>` for each send or jump target. The event `channel` field is the target, and metrics keep the RS-41 label set (no channel label). Stateful instances and the default breaker key are per that binding string, so the state-port key is `estela:care:<part>:flow:<flow>#<stepId>:<channel>` (RS-43). `try.held` counts once per step execution and target. The graph gains the annotations of the shared model (section 5.1 there): on each step and target, `id`, `care`, `repeatableBy`, and on the module `careProfiles: string[]`, which is present only when `CareModuleOptions.profiles` is non-empty. `CareEvent` gains an optional `channel` field (section 3.1). They contain names only, never values, regexes, keys, plan B values or `classify` functions. (amended) Event error text and attributes are redacted with the subject's sensitive policy (SD-62, SPI-433). **`care` and `repeatableBy` appear only on a step or target that has effective care; `id` appears only on a step that has an explicit `id`, effective care, or an annotation of another concern (`sensitive`, SD-59; `idempotency`, MR-49)**. This `id` rule is the same in the three library specs (SD Q17), so an unconfigured flow's graph JSON stays byte-identical to 0.9.0 (RS-70, SD-65, MR-50). | Given a jump step with profile `jump-sla` plus inline fields. When the graph is taken. Then its target shows `care: 'jump-sla+inline'` and `repeatableBy: 'key'` or `'declared'`. Given a flow with no options. Then its steps have no `id`, `care` or `repeatableBy` key. Given a payload with `secret-123`. Then no event, metric label or graph value contains it. | RU-66a, RU-66b |
| RS-67 (amended) | MUST | **Boot resolution.** One `FlowParameterResolver` runs in `IntegrationRuntime.onModuleInit` **after** channels are created (step 1) and **before** activators and outbound bindings (step 2), because those take profile names, and so before flows attach (step 3) (`integration.module.ts:245-286`). It builds every flow (`build()`), resolves every reference of every subject, and freezes the plans. Step 3 attaches the flows the resolver built: `build()` is still called once per flow definition, as in 0.9.0 (`integration.module.ts:267`). It collects **all** findings before reporting. If any finding is an error, it throws the error class of the concern (`CareConfigError` for resilience; `FlowDefinitionError` for the flow-shape codes `WIRETAP_CARE`, `DUPLICATE_STEP_ID` and `CARE_PART_NOT_ALLOWED` on `filter`, `transform` or `reply`). (amended) The same resolver also resolves the sensitive (SD-55) and idempotency (MR-47) references, and this requirement owns the class rule for all of them: when every error finding belongs to one concern, that concern's class is thrown (`CareConfigError`, `SensitiveConfigError`, `ReplicaConfigError`, or `FlowDefinitionError` for the flow-shape codes); when the error findings span more than one concern, `FlowDefinitionError` is thrown. Value-shape errors that the idempotency concern throws as `TypeError` (MR-36 as amended, MR-46, MR-53; MR section 16.5) are checked before any finding is collected. Either way exactly one error is thrown, and its `findings` property lists every finding of every concern as `FlowParameterFinding` (section 3.10), and its message names the subject and the option path (`flow 'loan' step 'credit': care.use unknown profile 'jump-slo'`). Warnings are logged once each. Resilience codes: errors `UNKNOWN_PROFILE`, `PROFILE_CYCLE`, `PROFILE_DEPTH`, `CARE_PART_NOT_ALLOWED`, `WIRETAP_CARE`, `LEGACY_AND_NEW_SAME_LAYER`, `PLAN_B_CHANNEL_MISSING`, `DUPLICATE_STEP_ID`, and every rule of section 5.6 applied to each resolved plan; warnings `TRIES_WITHOUT_KEY`, `TRIES_STACKED` and a primitive dropped from L1..L3. `route` targets are known only at run time: their plans are resolved from the frozen registry on first use and cached per channel. A channel that is not registered fails with `ChannelNotFoundError` and caches nothing. Profile names in ad-hoc `request()` options are checked on the first call and throw `UNKNOWN_PROFILE` (RS-03, RS-33). | Given two flows with one unknown profile each. When the module boots. Then one `CareConfigError` lists both findings and no channel has a subscriber. Given an activator with `care: 'p'` where `p` exists. Then it boots, which proves the resolver ran before step 2. | RU-67, RE-09 |
| RS-68 (amended) | MUST | **Call level (L5) for outbound REST.** `OutboundRestCallOptions.care?: CareRef` with the RS-33 limits: `valve`, `lanes` and `pace`, inline or through a profile, and including the value `false`, fail the call with `CareConfigError` before any attempt. `care: false` on a call is refused the same way, because it would bypass the binding's breaker, bulkhead and rate limiter; a call turns off a stateless primitive with `retry: false`, `timeout: false` or `planB: false`. The binding's own stateful primitives still apply, because they are L4 instances. A profile name is checked against the frozen registry (`UNKNOWN_PROFILE`). `timeoutMs` and `care.patience.eachTryMs` on the same call fail with `LEGACY_AND_NEW_SAME_LAYER`. Plans of `(binding, profile name)` are cached; an inline call object is resolved per call and holds no state. A call with no `care` behaves as before. | Given a binding with a breaker and a call `{ care: { tries: { max: 1 } } }`. When the breaker is open. Then the call fails with `ValveShutError` and is not retried. Given a call `{ care: { lanes: {...} } }`, `{ care: { valve: false } }` or `{ care: false }`. Then `CareConfigError` and 0 fetches. | RU-68 |
| RS-69 (amended) | SHOULD | **In-chain deadline narrowing.** `CareScope` carries the monotonic `deadlineAt` of the enclosing executor. A nested executor started in the same async chain (for example an outbound call made inside a `handle` step or an activator) caps its own deadline at it, and its per-attempt timeouts with it. The cap does not cross a channel hop (AGENTS.md invariant 7) or the wire (OQ-4). A legacy-alias plan (section 1) ignores `deadlineAt`, as it ignores the retry budget (R11), so a binding that configures no `care` keeps its 0.9.0 timing. | Given a `handle` step with `totalMs: 1000` whose `fn` calls a binding with `totalMs: 5000` and a backoff of 600 ms. When the binding fails twice at t=300 and t=900. Then the binding fails with `OutOfTimeError` no later than t=1000. Given the same `fn` calling a binding with only the legacy `timeoutMs: 5000`. Then that call's timer is 5000 ms. | RU-69 |
| RS-70 (amended) | MUST | **Backward compatibility of flows.** A flow with no `FlowOptions`, no step `care`, no `ChannelSpec.care` on any destination, and no `defaults` for `flow-*` kinds behaves byte-for-byte as in 0.9.0: the same hops and headers, the same 10000 ms jump wait, the same error envelopes, no care events, and the same graph JSON. **(amended)** While the module has no care configuration at all (no `forRoot({ care })`, no `care` on any channel, flow, step, activator, inbound endpoint or outbound binding), the flow also opens no `CareScope`, a `wireTap` copy keeps every header (including `triesLeft`), a reply that carries `planB: true` does not mark the flow, and a downstream plan B reply never releases the flow's idempotency claim: every one of these is the 0.9.0 behaviour. `forRoot({ care })` alone changes nothing in flows except the `triesLeft` scope of RS-65. The existing flow, jump and fanout spec files pass unmodified. | The existing specs that exercise flows pass unmodified: `src/flow/flow-executor.spec.ts`, `src/channels/orphaned-waits.spec.ts`, `src/graph/channel-graph.spec.ts`, `src/integration.module.spec.ts`, `src/idempotency/idempotency.spec.ts`, `src/trace/hop-logger.spec.ts`, `src/example/insurance/insurance.spec.ts`, `src/message.spec.ts`, `test/insurance.e2e.spec.ts`, `test/orders.e2e.spec.ts` and `test/inbound-adaptable.e2e.spec.ts`. A snapshot of `GET /integration/graph` for the insurance example is identical before and after. | RU-70, existing flow specs |
| RS-71 (amended) | MUST | **Reference forms on the other endpoints** (shared model section 3.4). `ActivatorOptions.care`, `OutboundRestOptions.care` and saga `OutboundOptions.care` accept a `CareRef`. `InboundSpec.care` and `InboundDefaults.care` accept an `InboundCareRef`, and a profile used there must hold only `lanes` and `pace` (RS-37). `bindGrpcOut(registry, fromChannel, stub, options?)` takes `{ replyChannel?, id?, care?, sensitive? }`; its engine is wired by SPI-430, and until then a `care` on it is validated but not applied, with one warning. `bindGrpcOut` is a plain function the app calls, not a boot step, so its reference is validated when it is called, against the frozen profile registry; a call made before the module's resolver ran (RS-67) throws `CareConfigError`. A saga step whose own reference resolves a `planB` fails with `SagaDefinitionError` (RS-38). On REST surfaces, the inline form of `CareRef` is `OutboundRestCare & { use?: ProfileName }`, so `tries.methods` stays available. A profile whose `tries.methods` is resolved onto a non-REST edge fails boot with `CareConfigError` at `tries.methods` (OQ-20). | Given `@ServiceActivator('c', { care: 'act-std' })`. When booted. Then the activator uses `act-std`. Given `@InboundRest({ ..., care: 'http-std' })` where `http-std` has `retry`. Then boot fails. Given `.outbound('pay', run, { care: 'with-fallback' })`. Then `SagaDefinitionError`. | RU-71 |

## 3. Public API by file

All new files are under `src/resilience/` unless stated otherwise. Every comment is English and ASCII-only (`npm run comments:en`). Nothing in `src/resilience/` imports from `outbound/`, `inbound/`, `activator/` or `saga/`. Dependencies go the other way, and a madge check verifies there are no cycles.

### 3.1 `resilience.types.ts`

```ts
import type { IntegrationMessage } from '../message';

export type FailureClass = 'transient' | 'busy' | 'rejected' | 'quota' | 'unknown';
export type TurnedAwayKind = 'valve-shut' | 'lanes-full' | 'over-pace' | 'out-of-time';
export type PlanBTrigger = FailureClass | TurnedAwayKind;
export type SpreadMode = 'full' | 'half' | 'none';
export type CareEdge =
  | 'outbound-rest' | 'outbound-grpc' | 'outbound-sdk' | 'activator' | 'inbound'
  | 'saga-outbound' | 'flow-handle' | 'flow-jump' | 'flow-send';

export interface Classification { class: FailureClass; /** >= 0 */ readyInMs?: number }

export interface CareContext {
  edge: CareEdge; binding: string; channel?: string; message?: IntegrationMessage;
  /** 1-based; 0 while keys are resolved before the first try. */
  tryNumber: number;
  /** Edge data (REST: the OutboundExchangeContext of the try). Never logged. */
  data?: unknown;
}
export type CareClassifierFn = (error: unknown, ctx: CareContext) => FailureClass | Classification | undefined;
export type CareKeyFn = (ctx: CareContext) => string;

/** How long Estela waits. */
export interface Patience {
  /** Longest wait for one try, ms; 0 = no limit. 0.9.0 spelling: `timeoutMs`. */
  eachTryMs?: number;
  /** Longest whole call: waiting turns, tries and gaps. */
  totalMs?: number;
}

/** Gap between tries. */
export interface Spacing { firstMs?: number; growth?: number; capMs?: number; spread?: SpreadMode }
export type SpacingFn = (tryNumber: number, error: unknown) => number;

/** Trying again after a failure. */
export interface Tries {
  enabled?: boolean;
  /** Total tries including the first; 1..20; default 3. */
  max?: number;
  spacing?: number | Spacing | SpacingFn;
  /** Default ['transient', 'busy']; 'quota' refused. */
  on?: readonly Exclude<FailureClass, 'quota'>[];
  /** Wait as long as the other side asks; default true. */
  heedServerWait?: boolean;
  /** A longer requested wait ends the call; default spacing.capMs. */
  maxServerWaitMs?: number;
  /** Safe to repeat without an idempotency key; default false. */
  idempotent?: boolean;
  /** A non-safe call without an idempotency key fails before the first try (RS-48). */
  requireIdempotencyKey?: boolean;
  /** 'keep' (default): spend the extra tries here, send 0 downstream. 'forward': pass them on. */
  triesLeft?: 'keep' | 'forward';
}

/** What a valve does when a call fails with the 'quota' class (RS-16, D35). */
export enum OnQuota {
  /** Shut for shutMs, then let probes through, like any other shut. Default. */
  ShutLikeFailure = 'shut-like-failure',
  /** Shut for quotaShutMs, then let probes through. */
  ShutFor = 'shut-for',
  /** Stay shut, with no probes, until CareControl.resume is called (RS-49). */
  ShutUntilResumed = 'shut-until-resumed',
}

/** Shuts traffic to a dependency that keeps failing, then lets probes through. */
export interface Valve {
  enabled?: boolean;
  key?: CareKeyFn;
  /** Failure percent that shuts the valve; 1..100; default 50. */
  failPercent?: number;
  /** Calls to see before judging; default 10. */
  minCalls?: number;
  /** Default { lastCalls: 20 }. */
  lookBack?: { lastCalls: number } | { lastMs: number };
  /** How long the valve stays shut; default 30000. */
  shutMs?: number;
  /** Trial calls when the shut period ends; default 1. */
  probes?: number;
  /** Default ['transient']; 'quota' always shuts. */
  countOn?: readonly FailureClass[];
  /** What a 'quota' failure does; default OnQuota.ShutLikeFailure (RS-16, RS-49). */
  onQuota?: OnQuota;
  /** Integer ms >= 1; required with OnQuota.ShutFor, refused otherwise. */
  quotaShutMs?: number;
  maxKeys?: number;
  state?: 'local' | CareStatePort;
  /** How long a shared "shut" mark is cached locally; default 1000. */
  syncMs?: number;
}

/** How many calls run at the same time. */
export interface Lanes {
  enabled?: boolean;
  /** Number of lanes, >= 1. */
  count: number;
  /** Calls that may wait for a free lane; default 0. */
  waitlist?: number;
  /** Default the remaining totalMs. */
  waitlistMs?: number;
}

/** How many calls start per second. */
export interface Pace {
  enabled?: boolean;
  /** > 0; 0.5 = one every 2 s. */
  perSecond: number;
  burst?: number;
  key?: CareKeyFn;
  /** Default 0: refuse at once. */
  waitMs?: number;
  state?: 'local' | CareStatePort;
  /** Per-pod rate while shared state is lost; default perSecond / replicas; never unlimited. */
  soloPerSecond?: number;
  maxKeys?: number;
  /** Pods sharing perSecond; default 1. */
  replicas?: number;
}

/** What answers when the call still fails. Exactly one of value | channel. */
export interface PlanB<R = unknown> {
  enabled?: boolean;
  value?: (error: unknown, ctx: CareContext) => R | Promise<R>;
  channel?: string;
  /** Default transient, busy and every TurnedAwayKind. */
  on?: readonly PlanBTrigger[];
  /** Default false: never stored as the idempotent result (RS-27). */
  cacheable?: boolean;
}

/** One set of care parts; each part is replaced whole by a higher level. */
export interface Care {
  classify?: CareClassifierFn | readonly CareClassifierFn[];
  patience?: false | Patience;
  tries?: false | Tries;
  valve?: false | Valve;
  lanes?: false | Lanes;
  pace?: false | Pace;
  planB?: false | PlanB;
}
export interface CareProfile extends Care { extends?: ProfileName }

/** Profile name | inline care | profile + inline overrides | false (nothing here and below). */
export type CareRefOf<C = Care> = ProfileName | (C & { use?: ProfileName }) | false;
export type CareRef = CareRefOf<Care>;

/** Inbound accepts lanes and pace only (RS-37). */
export type InboundCare = Pick<Care, 'lanes'> & {
  pace?: false | (Omit<Pace, 'key'> & { key?: (ctx: InboundCareContext) => string });
};
export type InboundCareRef = CareRefOf<InboundCare>;
/** What an inbound pace.key reads. */
export interface InboundCareContext {
  channel: string;
  transport: string;
  /** Raw transport headers; read tenant or route from here or from the guard's request user. */
  rawHeaders: Record<string, unknown>;
  /** Nest ExecutionContext, typed as unknown to keep src/resilience free of @nestjs imports. */
  execution: unknown;
}

export type CareEventType =
  | 'try.again' | 'try.held'
  | 'valve.shut' | 'valve.probing' | 'valve.flowing' | 'valve.forced-shut' | 'valve.keys-full'
  | 'lanes.full' | 'pace.over' | 'patience.ran-out'
  | 'plan-b.used' | 'plan-b.failed' | 'quota.used-up'
  | 'shared-state.lost' | 'shared-state.back';

export interface CareEvent {
  type: CareEventType;
  edge: CareEdge;
  binding: string;
  /** RS-66: the target channel of a flow send or jump edge; absent elsewhere. */
  channel?: string;
  /** keyLabel(key) when configured; never the raw key (RS-43). */
  keyLabel?: string;
  class?: FailureClass;
  reason?: TurnedAwayKind | 'waitlist-expired';
  tryNumber?: number;
  delayMs?: number;
  /** Wall-clock ms. */
  at: number;
  traceId?: string;
  correlationId?: string;
}

export interface CareMetricsPort {
  counter(name: string, labels: Record<string, string>, value?: number): void;
  histogram(name: string, labels: Record<string, string>, value: number): void;
  gauge(name: string, labels: Record<string, string>, value: number): void;
}

export interface CareClock {
  /** Monotonic ms (default performance.now). */
  monotonic(): number;
  /** Wall ms (default Date.now), for events and shared "shut" marks only. */
  wall(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  setTimer(ms: number, fn: () => void): CareTimer;
}
export interface CareTimer { cancel(): void }
/** Engine log sink; the module wires Nest `Logger('EstelaCare')` (RS-45). */
export interface CareLogger { log(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void }

/** forRoot({ care }) */
export interface CareModuleOptions {
  /** RS-53: named, reusable care settings. */
  profiles?: Readonly<Record<ProfileName, CareProfile>>;
  /** RS-54: L1 per edge; 'inbound' refused (use InboundDefaults.care). */
  defaults?: Partial<Record<CareEdge, CareRef>>;
  /** Default channel 'estela.care.events'; false disables. */
  events?: { channel?: string | false; onEvent?: (event: CareEvent) => void };
  metrics?: CareMetricsPort;
  /** Label of a custom key in events; never the raw key (RS-43, D-PHONE). */
  keyLabel?: (key: string, ctx: CareContext) => string | undefined;
  /** HMAC of a custom key; required with a custom key and shared state (RS-43). */
  keyHasher?: (key: string) => string;
  /** Default header 'x-tries-left'. */
  triesLeft?: { header?: string; initial?: number };
  /** Default 100 (provisional until SPI-444). */
  sharedStateWaitMs?: number;
  /** Default 5000. */
  sharedStateCheckMs?: number;
  clock?: CareClock;
  /** Test seam; default node:crypto randomInt. */
  random?: (maxExclusive: number) => number;
  logger?: CareLogger;
}

/** State of one valve as CareControl.valveState reports it. */
export interface ValveStateView { state: 'flowing' | 'shut' | 'probing'; forcedBy?: 'quota' }
```

### 3.2 `resilience.errors.ts`

```ts
export type CareErrorKind = TurnedAwayKind | 'plan-b-failed' | 'key' | 'config';
export interface CareErrorMeta { binding: string; edge?: CareEdge; tries?: number; cause?: unknown }
/** Message built only from the binding, the edge and the try count: `... after N try(ies)` (RS-44). */
export function careMessage(what: string, meta: CareErrorMeta): string;
export abstract class CareError extends ChannelError {
  static readonly errorKind?: CareErrorKind;
  static [Symbol.hasInstance](value: unknown): boolean;   // brand `@estela/nest.CareError`, RS-46
  abstract readonly kind: CareErrorKind;
  readonly binding: string;
  readonly edge: CareEdge | undefined;
  readonly tries: number;
}
export class ValveShutError   extends CareError { readonly kind = 'valve-shut';    readonly readyInMs?: number; readonly forcedBy?: 'quota' }
export class LanesFullError   extends CareError { readonly kind = 'lanes-full';    readonly reason: 'full' | 'waitlist-expired' }
export class OverPaceError    extends CareError { readonly kind = 'over-pace';     readonly readyInMs: number }
export class OutOfTimeError   extends CareError { readonly kind = 'out-of-time';   readonly totalMs: number }
export class PlanBFailedError extends CareError { readonly kind = 'plan-b-failed'; readonly original: unknown }
export type CareKeyErrorReason = 'key-fn' | 'invalid-key' | 'hasher' | 'idempotency-key-required';
export class CareKeyError     extends CareError { readonly kind = 'key'; readonly reason: CareKeyErrorReason }
/** Boot-time misconfiguration; message = `<binding>: care.<path> <rule>`. */
export class CareConfigError extends CareError {
  readonly kind = 'config'; readonly path: string; readonly code: string;
  /** (amended) RS-67: every finding of the boot pass; one entry when thrown on a first call. */
  readonly findings: readonly FlowParameterFinding[];   // section 3.10
}
/** Plan B trigger of a turned-away call; undefined for errors the engine did not raise. */
export function turnedAwayTrigger(error: unknown): TurnedAwayKind | 'quota' | 'none' | undefined;
// timeout.ts
/** One in-process try ran past eachTryMs (REST keeps OutboundTimeoutError). */
export class TryOverdueError extends ChannelError { readonly binding: string; readonly eachTryMs: number }
```

`ChannelError` is the existing base (`channel.ts:37`), so a consumer's `catch (e) { if (e instanceof ChannelError) ... }` keeps matching. `ChannelError(message)` takes no `cause` (`channel.ts:38-41`), so `CareError` sets `cause` itself with `Object.defineProperty`, as `ConcurrencyError` does through `super(message, { cause })`. The cross-bundle brand covers the `CareError` family only: a foreign copy of a `CareError` is not an `instanceof` the local `ChannelError`, because `ChannelError` has no brand.

### 3.3 `executor.ts`

```ts
export interface CareEdgeAdapter {
  readonly kind: CareEdge;
  /** Edge default classifier (RS-14, RS-15, or defaultInProcessClassifier for activators and saga steps, RS-17a). */
  classify(error: unknown, ctx: CareContext): Classification;
  /** RS-09: safe method, idempotency key present, or declared idempotent. */
  repeatable(ctx: CareContext): boolean;
  /** Error for a try that ran past eachTryMs (REST: OutboundTimeoutError). */
  overdueError(ctx: CareContext, eachTryMs: number): Error;
  /** Called per try with the tries left to send downstream (undefined = send nothing). */
  outgoingTriesLeft?(triesLeft: number | undefined): void;
  safe?(ctx: CareContext): boolean;
  idempotencyKey?(ctx: CareContext): string | undefined;
  defaultKey?(ctx: CareContext): string;
  isOverdue?(error: unknown): boolean;
}

/** One try handed to `run`. */
export interface CareTry {
  tryNumber: number;
  signal: AbortSignal | undefined;
  /** Effective wait of this try, 0 = no limit. */
  eachTryMs: number;
  /** Tries left to send downstream on this try. */
  triesLeftOut: number | undefined;
}

export interface CareResult<T> {
  value: T;
  tries: number;
  planB: boolean;
  durationMs: number;
}

export interface CareExecuteOptions { /** Per-call eachTryMs (REST call or target `timeoutMs`). */ eachTryMs?: number }

export class CareExecutor<T = unknown> {
  constructor(plan: CarePlan, adapter: CareEdgeAdapter, deps?: CareDeps);
  execute(ctx: Omit<CareContext, 'tryNumber'>, run: (current: CareTry) => Promise<T>, options?: CareExecuteOptions): Promise<CareResult<T>>;
}

/** The running try's signal, for activator methods, flow functions and saga outbound steps (RS-36). */
export function currentTrySignal(): AbortSignal | undefined;
```

### 3.4 `resilience.plan.ts`

```ts
export interface CarePlan { /* every part validated and defaulted; frozen */ }
export function resolveCarePlan(
  binding: string,
  layers: readonly (CareRef | undefined)[],   // call, binding, module default (highest first)
  edge: CareEdge,
  options?: { allowed?: readonly (keyof Care)[]; profiles?: Record<string, Care>; defaultEachTryMs?: number },
): CarePlan;          // throws CareConfigError (RS-03)
export function describeCare(plan: CarePlan): string | undefined;   // RS-42
```

### 3.5 `classifiers.ts`

```ts
/** RS-14. `error` is an OutboundRestError-like value, read structurally (kind, status, headers). */
export function defaultRestClassifier(error: unknown): Classification;
/** RS-15. Pure function of the numeric gRPC status code and the raw grpc-retry-pushback-ms value. */
export function defaultGrpcClassifier(code: number, pushback?: string): Classification;
/** RS-17a. Structural classifier for activators and saga outbound steps. */
export function defaultInProcessClassifier(error: unknown): Classification;
/** Legacy alias (section 1): boolean retryOn mapped to transient | rejected. */
export function fromBooleanClassifier(fn: (error: unknown, ctx: unknown) => boolean | Promise<boolean>): CareClassifierFn;
/** delta-seconds or HTTP-date to ms; undefined when invalid. */
export function parseServerWait(value: string | undefined, nowWallMs: number): number | undefined;
```

`fromBooleanClassifier` must keep an **async** legacy `retryOn` working (`MaybePromise<boolean>`, `outbound.types.ts:238-247`). The classifier chain is therefore awaited internally, and `CareClassifierFn` itself stays synchronous for new code.

### 3.6 `retry-budget.ts`

```ts
export const TRIES_LEFT_HEADER = 'x-tries-left';
export const TRIES_LEFT_MESSAGE_HEADER = 'triesLeft';
/** Reply header of a result built while a non-cacheable plan B ran (RS-27). */
export const PLAN_B_HEADER = 'planB';
export function parseTriesLeft(raw: unknown): number | undefined;      // RS-31
export interface CareScopeValue { triesLeft?: number; signal?: AbortSignal; fromEventsChannel?: boolean; planB?: boolean }
export class CareScope {                                           // ALS, RS-29
  static current(): (CareScopeValue & { deadlineAt?: number }) | undefined;
  /** (amended) `deadlineAt`: monotonic ms of the enclosing executor's totalMs (RS-69). */
  static run<T>(value: { triesLeft?: number; signal?: AbortSignal; deadlineAt?: number }, fn: () => T): T;
  /** RS-27: marks the current message scope (and its parents in the same chain) as answered by plan B. */
  static markPlanB(): void;
}
```

### 3.6a `backoff.ts` and `registry.ts`

```ts
export type JitterMode = 'full' | 'equal' | 'none';           // 0.9.0 saga name, moved from saga/retry-policy.ts
export const MAX_RETRY_ATTEMPTS = 20;                         // 0.9.0 name, moved; saga re-exports
export const MAX_BACKOFF_MS = 2_147_483_647;                  // 0.9.0 name, moved; saga re-exports
/** Internal: `SpreadMode` 'half' maps to JitterMode 'equal'. */
function backoffDelay(
  settings: { initialMs: number; factor: number; maxMs: number; jitter: JitterMode },
  tryNumber: number,
  random: (maxExclusive: number) => number,
): number;
/** Unchanged signature and output; implemented with backoffDelay (factor 2, cap backoffMs * 32). */
export function delayFor(
  policy: { backoffMs: number; maxBackoffMs?: number; jitter?: JitterMode },
  attempt: number,
  random: (maxExclusive: number) => number,
): number;

/** RS-49. Injectable when forRoot({ care }) is set. */
export abstract class CareControl {
  abstract valveState(binding: string, key?: string): ValveStateView | undefined;
  /** Reopens the flow and clears the shared "shut" marks. */
  abstract resume(binding: string, key?: string): Promise<void>;
}
/** DI token of the module-level engine (`CareEngine`); saga runners accept one. */
export const CARE_ENGINE = 'INTEGRATION_CARE_ENGINE';
```

### 3.7 `state-port.ts` and `redis/`

```ts
export interface CareStatePort {
  /** Atomic take of one turn; returns granted and ms until the next turn. */
  takeTurn(key: string, perSecond: number, burst: number): Promise<{ granted: boolean; readyInMs: number }>;
  /** Shared "shut" mark (RS-23); untilMs is wall-clock time. */
  markShut(key: string, untilMs: number): Promise<void>;
  shutUntil(key: string): Promise<number | undefined>;
  /** Probe lease; true for exactly one caller per lease period. */
  claimProbe(key: string, leaseMs: number): Promise<boolean>;
  clearShut(key: string): Promise<void>;
}

/** Script runner from the app (ioredis / node-redis snippets in the README). */
export type RedisEvalFn = (script: string, keys: readonly string[], args: readonly string[]) => Promise<unknown>;
export function redisCareState(evalScript: RedisEvalFn, options?: { prefix?: string }): CareStatePort;
```

The scripts are module-level string constants. Like the Postgres SQL constants (`saga/postgres/sql.ts`), this avoids sonarjs hotspots. Time comes from `redis.call('TIME')`.

### 3.8 Changes to existing files

```ts
// decorators.ts
export interface ActivatorOptions { group?: string; routingKey?: string; care?: CareRef }

// inbound/inbound.types.ts
export interface InboundSpec { /* existing */ care?: InboundCareRef }
export interface InboundDefaults { /* existing */ care?: InboundCareRef }

// inbound/inbound.transport.ts (optional method: additive on an implementable port)
export interface InboundTransportStrategy { /* existing */ rawHeaders?(context: ExecutionContext): Record<string, unknown> }

// inbound/inbound.failure.ts
export class InboundBusyError extends HttpException {   // status 429
  readonly code = 'INBOUND_BUSY';
  readonly grpcCode = 8;                                         // RESOURCE_EXHAUSTED
  constructor(readonly channel: string, readonly reason: 'lanes-full' | 'over-pace', readonly readyInMs?: number);
}

// outbound/outbound.types.ts
export interface OutboundRestCare extends Care {
  tries?: false | (Tries & { methods?: readonly OutboundRestMethod[] });
}
export interface OutboundRestOptions { /* existing */ care?: CareRefOf<OutboundRestCare> }
export type OutboundErrorMapperFn<P = unknown> = {
  bivarianceHack(error: OutboundRestError | CareError, ctx: OutboundExchangeContext<P>): unknown;
}['bivarianceHack'];
export interface OutboundErrorMapper<P = unknown> {
  mapError(error: OutboundRestError | CareError, ctx: OutboundExchangeContext<P>): unknown;
}

// saga/saga.ts
export interface OutboundOptions<Ctx, Tx> { /* existing */ care?: CareRef }   // planB refused

// graph/channel-graph.ts
export interface GraphOutboundRef { transport: OutboundTransport; target: string; care?: string }
export interface GraphInboundRef { /* existing */ care?: string }

// integration.module.ts
export interface IntegrationModuleOptions { /* existing */ care?: CareModuleOptions }

// saga/saga-runner.ts
export interface SagaRunnerOptions { /* existing */ care?: CareModuleOptions | CareEngine }
```

**(amended)** The `care?` fields above widen to the reference types of section 3.10 (RS-71). Their inline object forms are unchanged.

### 3.9 Barrels

- `src/index.ts` exports:
  - the public types of section 3.1, with the enum `OnQuota` exported as a value (D35);
  - the errors of section 3.2;
  - `CareExecutor`, `CareControl` and `currentTrySignal`;
  - `defaultRestClassifier`, `defaultGrpcClassifier`, `defaultInProcessClassifier`, `parseServerWait` and `parseTriesLeft`;
  - `redisCareState` and `InboundBusyError`;
  - (amended) the types of section 3.10 (`ProfileName`, `CareProfile`, `CareRef`, `InboundCareRef`, `StepCommonOptions`, `FlowTarget`, `FlowDest`, `FlowOptions`, `FlowParameterFinding`) and `FlowDefinitionError`, unless SPI-429 or SPI-433 already exported them. (amended, cross-spec) Under the agreed delivery order SPI-433 ships first and exports the shared scaffolding (`ProfileName`, `StepCommonOptions`, `FlowTarget`, `FlowDest`, `FlowOptions`, `FlowParameterFinding`, `FlowDefinitionError`; SD-67), so this ticket adds only `CareProfile`, `CareRef`, `InboundCareRef` and the `care` members of the shared types.
- `src/testing/index.ts` exports `manualCareClock`, `MemoryCareState` and `collectCareEvents`.

### 3.10 Flow DSL, channel and reference types (from the shared flow parameter model)

These shapes are copied from the shared model (sections 2 and 3 there). Where this spec departs from the model, the departure is listed in section 15 for the model's owners to settle (OQ-13, OQ-15, OQ-17, OQ-23); until then this spec's rule applies.

```ts
// Profile names: ^[a-z0-9][a-z0-9._-]{0,63}$
export type ProfileName = string;
export interface CareProfile extends Care {
  /** Single inheritance, resolved at boot; cycles and more than 8 hops fail boot (RS-53). SD-48 accepts a list for sensitive profiles (OQ-25). */
  extends?: ProfileName;
}
export type CareRef =
  | ProfileName
  | (Care & { use?: ProfileName })
  | false;
export type InboundCareRef =
  | ProfileName                      // profile must hold only lanes/pace (RS-37)
  | (InboundCare & { use?: ProfileName })
  | false;

// flow/flow-step.ts, flow/integration-flow.ts
export interface StepCommonOptions {
  /** Default `<kind>#<index>`; unique per flow (DUPLICATE_STEP_ID). */
  id?: string;
  sensitive?: SensitiveRef;          // SPI-433
}
export interface FlowTarget extends FanoutTargetInput {
  care?: CareRef;
  sensitive?: SensitiveRef;
}
export type FlowDest = string | FlowTarget;
export interface FlowOptions {
  care?: { handle?: CareRef; jump?: CareRef; send?: CareRef };
  sensitive?: SensitiveRef;          // SPI-433
  idempotency?: false | { ttlMs?: number; store?: StoreRef; onStoreUnavailable?: StoreUnavailablePolicy; scope?: string }; // SPI-429
}
static from(source: string, options?: FlowOptions): IntegrationFlow;
filter(predicate, opts?: StepCommonOptions): this;                         // care refused (RS-57)
transform(fn, opts?: StepCommonOptions): this;                             // care refused (RS-57)
handle(fn, opts?: StepCommonOptions & { care?: CareRef; idempotency?: false | StepIdempotencyOptions }): this;
wireTap(channel, opts?: StepCommonOptions & { redact?: boolean; redactReason?: string }): this;   // never care (RS-58)
fanoutTo(dests: readonly FlowDest[], opts?: StepCommonOptions & { care?: CareRef }): this;
jumpTo(dests: readonly FlowDest[], opts?: StepCommonOptions & { care?: CareRef }): this;
jump(channel: string, opts?: { wait?: boolean; timeoutMs?: number; care?: CareRef; sensitive?: SensitiveRef; id?: string }): this;
publish(channel: string, routingKey?: string, opts?: StepCommonOptions & { care?: CareRef }): this;
publish(channel: string, opts: StepCommonOptions & { care?: CareRef }): this;
route(fn, opts?: StepCommonOptions & { care?: CareRef }): this;
to(channel: string, opts?: StepCommonOptions & { care?: CareRef }): this;
reply(options?: ReplyOptions & { id?: string }): this;                     // care refused (RS-57)

// channel-factory.ts (other new fields belong to SPI-429 and SPI-433)
export interface ChannelSpec { /* existing */ care?: CareRef }

// decorators.ts, inbound/inbound.types.ts, outbound/outbound.types.ts, saga/saga.ts, adapters/grpc.adapter.ts
export interface ActivatorOptions { group?: string; routingKey?: string; care?: CareRef /* ... */ }
export interface InboundSpec { /* existing */ care?: InboundCareRef }
export interface InboundDefaults { /* existing */ care?: InboundCareRef }
export interface OutboundRestOptions { /* existing */ care?: CareRefOf<OutboundRestCare> }
export interface OutboundRestCallOptions { /* existing */ care?: CareRefOf<OutboundRestCare> }    // RS-68 limits
export interface OutboundOptions<Ctx, Tx> { /* existing */ care?: CareRef }   // planB => SagaDefinitionError
bindGrpcOut(registry, fromChannel, stub, options?: { replyChannel?: string; id?: string; care?: CareRef; sensitive?: SensitiveRef });

// flow/flow-definition-error.ts (new; shared with SPI-429 and SPI-433)
/** (amended) One finding shape for every concern of the resolver (RS-67). SD's SensitiveFinding and MR's
 *  ReplicaFinding map onto it: severity = their severity/level, concern names the owner. */
export interface FlowParameterFinding {
  readonly concern: 'flow' | 'care' | 'sensitive' | 'idempotency';
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly subject: string;          // e.g. "flow 'loan' step 'credit'"
  readonly path: string;             // option path, e.g. "care.use"
  readonly message: string;          // names only, never values
}
export class FlowDefinitionError extends Error { readonly findings: readonly FlowParameterFinding[] }
```

`SensitiveRef`, `StoreRef`, `StepIdempotencyOptions` and `StoreUnavailablePolicy` are defined by SPI-433 and SPI-429. This spec only passes them through.

## 4. File layout

```
src/resilience/resilience.types.ts      policy model, classes, events, ports
src/resilience/resilience.errors.ts     CareError family, brand
src/resilience/resilience.plan.ts       layering, validation, defaults, describeCare
src/resilience/backoff.ts               backoffDelay, delayFor, JitterMode, MAX_* (moved; saga re-exports)
src/resilience/registry.ts              CareControl (RS-49)
src/resilience/executor.ts              composition order, attempt loop, scope
src/resilience/timeout.ts               per-attempt timeout + deadline
src/resilience/circuit-breaker.ts       window, states, LRU registry, shared marker
src/resilience/bulkhead.ts
src/resilience/rate-limiter.ts          local bucket + shared bucket + degraded switch
src/resilience/fallback.ts
src/resilience/classifiers.ts           REST, gRPC, legacy adapter, Retry-After parser
src/resilience/retry-budget.ts          header parse, ALS scope
src/resilience/state-port.ts            port + degraded wrapper (sharedStateWaitMs, probe)
src/resilience/redis/{scripts,redis-state-port}.ts   no npm imports
src/resilience/observability.ts         event publisher, metrics fan-out, keyLabel
src/resilience/index.ts
src/resilience/**/*.spec.ts
src/outbound/{outbound.call,outbound.plan,outbound.types,outbound-rest.gateway}.ts   alias + executor
src/activator/activator-wrapper.ts, src/decorators.ts
src/inbound/{inbound.interceptor,inbound.types,inbound.failure,inbound.transport}.ts
src/flow/flow-executor.ts, src/gateway/reply-gateway.ts, src/channel-registry.ts   scope, degraded mark, budget copy
src/flow/{integration-flow,flow-step}.ts, src/flow/steps/*.ts                     step options, flow edge adapters (RS-55..RS-66)
src/flow/flow-parameter-resolver.ts     FlowParameterResolver (RS-67; shared with SPI-429 and SPI-433)
src/channel-factory.ts                  ChannelSpec.care
src/saga/{saga,saga-runner,retry-policy}.ts
src/graph/channel-graph.ts, src/integration.module.ts       (header mappers are NOT touched, RS-29)
src/testing/{manual-resilience-clock,memory-resilience-state-port,resilience-events}.ts
test/resilience.e2e.spec.ts             HTTP loopback, two in-process apps
test/resilience-redis.e2e.spec.ts       skipped unless ESTELA_REDIS_URL
test/resilience-flow.e2e.spec.ts        flows, profiles, channel defaults (RE-08, RE-09)
docs/ESTELA_RESILIENCE_SPEC.md          this file
```

**Repo rules this layout must satisfy:**
- **Complexity.** `complexity` <= 12 and sonarjs cognitive complexity <= 15. The executor composes one small function per primitive, and none of them holds the whole loop.
- **No clones.** jscpd at 60 tokens: the breaker and the rate limiter share the degraded switch from `state-port.ts`.
- **New depcruise rules.**
  - `resilience-no-npm`: nothing under `^src/resilience/` depends on an npm package.
  - `resilience-is-leaf`: `src/resilience/` does not import `src/outbound`, `src/inbound`, `src/activator`, `src/saga` or `src/flow` (amended). The flow edge adapters, including the classification by error name of RS-63, live in `src/flow/`.
- **devDependency for the Redis e2e only.** One Redis client is added for `test/` (proposal: `ioredis`), and it is declared in the PR. After installing it, run `npm audit` and lockfile-lint again.
- **Timers.** No timer outlives a call. The probe timers of degraded state are `unref()`'d and cleared in `IntegrationRuntime.onApplicationShutdown`.

## 5. Algorithm and behaviour

### 5.1 Executor

```text
execute(ctx, run):
  plan, adapter, deps fixed at construction
  if plan is empty: return { value: await run({attempt:1, signal: undefined, timeoutMs: 0, triesLeftOut: inbound budget}), ... }
  if requireIdempotencyKey and not safe and no key: throw CareKeyError('idempotency-key-required')   # RS-48
  deadlineAt = plan.totalMs ? clock.monotonic() + plan.totalMs : Infinity
  try:
    return await withFallback(ctx, () =>                        # fallback, outermost
      withDeadline(deadlineAt, () =>                            # deadline
        withBulkhead(ctx, deadlineAt, () =>                     # one slot for the whole call
          retryLoop(ctx, deadlineAt, run))))
  retryLoop:
    budgetIn  = message.headers.triesLeft ?? CareScope.current()?.budget ?? options.triesLeft.initial
    retries   = repeatable(ctx) ? min(maxAttempts - 1, budgetIn ?? Infinity) : 0
    if maxAttempts > 1 and retries == 0: emit retry.suppressed (once)
    triesLeftOut = retries > 0 and triesLeft == 'claim' ? 0 : budgetIn
    for attempt in 1..retries+1:
      key resolution (key fn, then keyHasher) happens once per call (attempt 0), so every attempt hits the same breaker and bucket
      breaker.admit(key)          -> ValveShutError (never retried, RS-12; cause = previous error; forcedBy when quota)
      limiter.take(key, deadline) -> OverPaceError (never retried); frees a half-open probe slot it holds
      timeoutMs = min(eachTryMs || Infinity, deadlineAt - now); cutByDeadline = (deadlineAt - now) < eachTryMs
      outcome = CareScope.run({ budget: triesLeftOut, signal }, () => withTimeout(timeoutMs, run))
      if success: breaker.recordSuccess(key); return
      c = classify(error)                       # app chain, then edge default, then 'unknown'
      if c.class == 'quota': breaker.forceOpen(key, quotaShutLength(onQuota), shared); emit quota.used-up; throw error
      if c.class in countOn and not (timed out and cutByDeadline): breaker.recordFailure(key)   # RS-07
      if attempt > retries or c.class not in retryOn: throw error
      delay = delayFor(backoff, attempt, random)
      if heedServerWait and c.readyInMs != undefined:
        if c.readyInMs > maxServerWaitMs: throw error
        delay = max(delay, c.readyInMs)
      if now + delay >= deadlineAt: throw OutOfTimeError(cause = error)
      emit retry; await clock.sleep(delay)
```

The plan B layer catches the final error, computes its trigger (a `FailureClass` from the classifier, the `TurnedAwayKind` of a `CareError`, or `'quota'` for a `ValveShutError` with `forcedBy: 'quota'`), and runs the fallback only when that trigger is in `on`. A `CareKeyError` or `CareConfigError` has no trigger and never runs the fallback. When the fallback runs and `cacheable` is false, it calls `CareScope.markPlanB()` (RS-27).

### 5.2 Default classifiers

**REST** (`defaultRestClassifier`, used only under `care`):

| Failure | Class | `readyInMs` |
|---|---|---|
| `OutboundNetworkError` (any code) | transient | n/a |
| `OutboundTimeoutError` | transient (retried only if repeatable, RS-09) | n/a |
| HTTP 408, 425 | transient | from `Retry-After` |
| HTTP 429 | throttled | from `Retry-After` |
| HTTP 500, 502, 504 | transient | n/a |
| HTTP 503 | transient | from `Retry-After` |
| HTTP 501, 505, 511 | rejected | n/a |
| Other 5xx | transient | n/a |
| Other 4xx, 3xx not followed | rejected | n/a |
| Anything that is not an `OutboundRestError` | unknown | n/a |

Resolver and response-mapper errors never reach the classifier (RS-14).

**gRPC** (`defaultGrpcClassifier`, for SPI-430):

| Code | Class |
|---|---|
| 14 `UNAVAILABLE` | transient |
| 4 `DEADLINE_EXCEEDED` | transient (retried only if repeatable) |
| 8 `RESOURCE_EXHAUSTED` | busy (`readyInMs` from `grpc-retry-pushback-ms`); rejected when the pushback is negative or not an integer |
| 10 `ABORTED` | rejected (idempotency in flight on the callee; the client retries later, not this layer) |
| 3, 5, 6, 7, 9, 11, 12, 16 | rejected |
| 1 `CANCELLED`, 2 `UNKNOWN`, 13 `INTERNAL`, 15 `DATA_LOSS` | unknown |
| 0 `OK` | never classified |

The "unknown" mapping of codes 1, 2, 13 and 15 is deliberate: they are not retried and not recorded by default. A service that knows its callee's `INTERNAL` errors are transient can say so in `classify`.

### 5.3 429, breaker, quota and fallback (with default settings)

| Class / rejection | Retried | Recorded by the breaker | Fallback by default | Event |
|---|---|---|---|---|
| transient | yes | yes (failure) | yes | `try.again` per extra try |
| busy (429, `RESOURCE_EXHAUSTED`) | yes, heeding `Retry-After` | **no** | yes | `try.again` |
| rejected (4xx, `INVALID_ARGUMENT`) | no | no | no | none |
| quota (app classifier only) | **no** | forces open (per `onQuota`: `shutMs`, `quotaShutMs`, or until resumed) | **no**, also for the `ValveShutError { forcedBy: 'quota' }` that follows | `quota.used-up`, `valve.forced-shut` |
| unknown | no | no | no | none |
| valve-shut (not quota-forced) | no | n/a | yes | `valve.*` on changes only |
| bulkhead-full / rate-limited | no | no | yes | `lanes.full` / `pace.over` |
| deadline | no | an attempt cut by the deadline is not recorded (RS-07) | yes | `patience.ran-out` |

**Why 429 does not open the breaker by default.** A 429 means the callee is healthy and is asking the caller to slow down. Backoff and the rate limiter answer that. Opening the breaker would turn a throttling signal into an outage. A service that wants otherwise lists `'busy'` in `countOn`.

### 5.4 Shared state and D-REDIS-DOWN

```text
stateCall(op):
  if binding.degraded and now < nextProbeAt: use local
  try result = await race(op(), timer(min(sharedStateWaitMs, deadlineAt - now))) -> on success: if degraded: degraded=false; emit shared-state.back
  catch / timeout: if not degraded: degraded=true; emit shared-state.lost; warn
                   nextProbeAt = now + sharedStateCheckMs; use local for THIS call (never retry the port inside a call)
local limiter while degraded: bucket(soloPerSecond, burst = max(1, floor(burst / replicas)))
local breaker while degraded: per-pod window only; a shared open marker read earlier stays valid until its untilMs
the degraded flag is per binding and set once (compare-and-set), so N concurrent failures emit one shared-state.lost
```

**Idempotency store unavailable (D-REDIS-DOWN, second half).** The idempotency stores belong to SPI-429. The multi-replica spec (`MR-`) defines how they fail: channels marked as side-effecting fail closed with a retryable error, and other channels fail closed unless configured otherwise. The resilience engine has only one interaction with that rule. The error such a store raises, `IdempotencyStoreUnavailableError` (named in the `MR-` spec, with `retryable: true`), and SPI-433's `SensitiveKeyUnavailableError` (also `retryable: true`) are classified `'transient'` by `defaultInProcessClassifier` (RS-17a). A remote caller sees them as the HTTP or gRPC status that SPI-429 and SPI-431 map them to, and its REST or gRPC default classifier decides from that status. Under the budget rule (RS-28), they are retried by the outermost retrying layer, never inside the same request.

### 5.5 Composition per edge

| Edge | Primitives allowed | Retry gating | Where it hooks |
|---|---|---|---|
| Outbound REST | all | RS-09, REST rule | `exchange` loop in `outbound.call.ts:156-184` replaced by the executor; the legacy alias builds a plan whose behaviour is exactly the loop it replaces |
| Outbound gRPC (SPI-430) | all | adapter `repeatable` (method declared idempotent, or idempotency metadata present) | SPI-430 |
| SDK outbound (SPI-436) | all | adapter `repeatable` | SPI-436 |
| Activator | all | `idempotent: true` or message key | around `runActivatorMethod` (`activator-wrapper.ts:99,118-139`) |
| Inbound REST, gRPC, GraphQL | bulkhead, pace | n/a | `InboundInterceptor.intercept`, before `next.handle()` |
| Inbound Rabbit | none (definition error) | n/a | n/a |
| Saga outbound step | all except `planB` | `idempotent: true` required for `tries.max > 1` | around `step.run(ctx)` inside `tracer.traced` (`saga-runner.ts:310-313`) |
| Flow `handle` (`flow-handle`) | all; `planB` `value` or `channel` | RS-60: message key, step key resolver, or `idempotent: true` | around `this.fn(...)` in `HandleStep.execute` (`handle.step.ts:14-18`), inside the step claim |
| Flow `jump`/`jumpTo` (`flow-jump`) | all; `planB` only on awaited targets | RS-60 | around one `runJump` attempt per target (`jump.step.ts:50-78`); section 5.7 |
| Flow `to`, `publish`, `route`, `fanoutTo` (`flow-send`) | all except `planB`; `to` accepts `planB: { channel }` as a plain send | RS-60 | around `ctx.registry.sendMessage(target, hop)` per target (`to.step.ts:22`, `publish.step.ts:24`, `route.step.ts:29`, `fanout.step.ts:27`) |
| `wireTap`, `filter`, `transform`, `headers` (D37), `reply` | none (RS-57, RS-58) | n/a | n/a |

### 5.6 Configuration validation at boot (RS-03)

Each rule below throws `CareConfigError` naming its path:
- **Integers.**
  - `tries.max` must be 1..20.
  - `eachTryMs` must be 0..2^31-1, and `totalMs` 1..2^31-1.
  - `shutMs`, `quotaShutMs`, `syncMs` and `waitlistMs` must be >= 1.
  - `minCalls`, `probes`, `maxKeys`, `count`, `burst` and `replicas` must be >= 1.
  - `waitlist` and `waitMs` must be >= 0.
  - The window `size` must be >= `minCalls`, and `sizeMs` must be >= 1.
- **Other number ranges.**
  - `failPercent` must be 1..100.
  - `perSecond` and `soloPerSecond` must be finite and > 0.
  - Backoff: `initialMs` >= 0, `factor` >= 1, and `maxMs` >= `initialMs`.
- **Classes and option shapes.**
  - `tries.on` and `valve.countOn` must be non-empty, with no duplicates, and use known classes. `'quota'` is refused in `tries.on`.
  - `planB` must have exactly one of `value` or `channel`. A `channel` fallback needs the channel to exist at boot.
  - `on` must contain only known triggers.
- **Edge restrictions.**
  - A primitive not allowed on the edge is refused (section 5.5).
  - `planB` on a saga outbound step is refused, and so is `tries.max > 1` on a saga outbound step without `idempotent: true`. Both raise `SagaDefinitionError`.
  - Legacy and new options for the same primitive on the same layer are refused (RS-35).
- **Shared state.** `state` must be `'local'` or an object implementing every `CareStatePort` method. A custom `key` with a shared `state` needs a module `keyHasher` (RS-43).
- **Ad-hoc outbound options.** `valve`, `lanes` and `pace` are refused, on the first call (RS-33).
- **Idempotency key rule.** `requireIdempotencyKey: true` with `idempotency: false` on a REST binding is refused (RS-48).
- **Quota mode (RS-16).** `valve.onQuota` must be one of the `OnQuota` string values (`'shut-like-failure'`, `'shut-for'`, `'shut-until-resumed'`); any other value, including a raw string from JavaScript, is refused at `valve.onQuota`. `quotaShutMs` is required with `OnQuota.ShutFor` and refused with any other mode, at `valve.quotaShutMs`.
- **Legacy aliases.** `retry` and `timeoutMs` outside `care` keep the 0.9.0 validation and `OutboundError` (section 1). The rules above apply only to values under `care`.
- **References and levels (amended, RS-53..RS-67).**
  - Unknown profile name: `UNKNOWN_PROFILE`. `extends` cycle: `PROFILE_CYCLE`. Chain deeper than 8: `PROFILE_DEPTH`. Profile name outside `^[a-z0-9][a-z0-9._-]{0,63}$`: error at `care.profiles.<name>`.
  - `care.defaults.inbound`, or `defaults['outbound-rest']` together with `outbound.rest.defaults.care`: refused (RS-54).
  - A primitive set at L4 on an edge that refuses it: `CARE_PART_NOT_ALLOWED`. The same primitive inherited from L1..L3 is dropped with a warning.
  - `care` on `wireTap`: `WIRETAP_CARE`. On `filter`, `transform` or `reply`: `CARE_PART_NOT_ALLOWED`. Duplicate step id: `DUPLICATE_STEP_ID`. All three raise `FlowDefinitionError`.
  - A jump target with both `timeoutMs` and `care.patience.eachTryMs`, or a REST call with both `timeoutMs` and `care.patience.eachTryMs`: `LEGACY_AND_NEW_SAME_LAYER`.
  - A `planB.channel` that is not registered at boot: `PLAN_B_CHANNEL_MISSING`.
  - An inbound reference whose profile holds anything but `lanes` and `pace`, and `tries.methods` resolved onto a non-REST edge, are refused (RS-71).
- **Warnings that are not errors.** These are logged once at boot:
  - `totalMs < eachTryMs` (the per-attempt timeout is effectively capped);
  - `tries.max > 1` on an activator that has no `idempotent: true`, because then only a message key enables retries.
  - `TRIES_WITHOUT_KEY`, `TRIES_STACKED`, and each primitive dropped from L1..L3 (RS-59, RS-60);
  - `tries.idempotent: true` and `planB.cacheable: true` on a flow step, named with the subject (RS-60, RS-64);
  - `care` on `bindGrpcOut` before SPI-430 wires the engine (RS-71).

### 5.7 Flow edges (RS-55..RS-66)

**What one send attempt covers, per destination kind** (verified in section 0.1):

| Destination kind | One attempt covers | Failures an attempt can see | Consequence for retries |
|---|---|---|---|
| `direct` | the subscriber's whole handling (a flow run or an activator) | the handler's error; `NoSubscriberError` | a retry runs the downstream handler again, so RS-60 gates it |
| `queue` | buffering only | `CapacityExceededError` | the per-attempt timeout bounds only the enqueue; a retry is a backpressure wait |
| `pubsub` | `Promise.allSettled` over the subscribers | none from subscribers (they go to `onError`); `ChannelNotFoundError` | only a timeout can fail the attempt, and a retry after it delivers again to every subscriber (R15) |
| `fanout` | each binding's send | `ChannelNotFoundError`; a binding's direct-subscriber error | as `direct`, per binding |

**Classification on flow edges** (RS-63), applied by error `name` before `defaultInProcessClassifier`:

| Error name | Class | Edge |
|---|---|---|
| `JumpTimeoutError` | transient | flow-jump |
| `CapacityExceededError` | throttled | flow-send, flow-jump |
| `NoSubscriberError`, `ChannelNotFoundError`, `FanoutCycleError` | rejected | flow-send, flow-jump |
| anything else | `defaultInProcessClassifier` (RS-17a) | all flow edges |

**Jump target with a policy** (RS-62, RS-64):

```text
jumpTarget(ctx, target, plan):
  hop = nextHop(msg, { channel, component: `jump:<flow>` })        # built once per target (RS-61)
  legacyWait = target.timeoutMs ?? 10000                           # jump.step.ts:13,36
  result = executor.execute({ edge: 'flow-jump', binding: `flow:<flow>#<id>:<channel>`, channel, message: msg }, (a) =>
    replyName = `reply.<uuid>`; register(replyName)
    # plan.eachTryMs defaults to legacyWait when no level sets it; a.timeoutMs = min(eachTryMs, remaining deadline)
    wait = firstMessage(replyName, isFinite(a.timeoutMs) && a.timeoutMs > 0 ? a.timeoutMs
                                   : (plan.totalMs ? remainingDeadline : legacyWait))   # never unbounded (RS-62)
    try:
      send(channel, copy(hop, { replyChannel: replyName, jumpReply: '1', triesLeft: a.triesLeftOut }))
      reply = await wait
      if reply.headers.degraded: CareScope.markPlanB()     # RS-64
      return reply.payload
    finally: wait.cancel(); unregister(replyName)                   # late replies are dropped
  )
  jumpReplies[channel] = result.value
  if result.planB: jumpPlanB[channel] = true                 # markPlanB already ran (RS-27)
```

`triesLeft` is written on the hop only when `forRoot({ care })` is set (RS-65). A plan without primitives (`care: false`, or nothing resolved) skips the executor and runs the 0.9.0 `runJump` unchanged (RS-70).

## 6. Invariants (each has a unit test)

- **I1.** A dependency call is made only after the breaker admitted it and a rate-limit token was granted, for every attempt (RU-02).
- **I2.** No sleep or wait (backoff, queue, rate limit) goes past the deadline (RU-07b).
- **I3.** A non-repeatable operation is attempted at most once (RU-09a).
- **I4.** Along one call path, at most one Estela layer makes more than one attempt, provided every layer on the path is configured under `care` with `triesLeft: 'keep'` and its module sets `forRoot({ care })`. A legacy-alias binding is outside this guarantee (R11) (RU-30a, RE-03).
- **I5.** A raw custom key never leaves the engine. Only `keyLabel` output or `keyHasher` output does (RU-43a, RU-43c).
- **I6.** A bulkhead slot and a half-open probe slot are always released, on success, failure, timeout, abort and fallback (RU-21, RU-19).
- **I7.** Event and metrics failures never change a call's outcome (RU-40a, RU-41).
- **I8.** Without `care` configured anywhere, the code paths, wire headers and graph JSON are those of 0.9.0 (RU-34, plus the unmodified existing specs).
- **I9.** Each call's admission is decided by exactly one state source, local or shared. There is never a "both" or an unlimited path (RU-24a).
- **I10.** A degraded result is never stored as an idempotent completed result unless `cacheable: true` (RE-06, RU-27).
- **I11.** The local breaker map and bucket map of a policy never hold more than `maxKeys` entries (RU-20a, RU-22a).
- **I12.** A quota-forced breaker never runs a fallback whose `on` lacks `'quota'`, and with `onQuota: OnQuota.ShutUntilResumed` it never probes (RU-16a, RU-16c).
- **I13.** A flow step makes more than one attempt only under a message key, a step key resolver or `tries.idempotent: true` (RU-60a).
- **I14.** A `wireTap` never retries, never waits and never carries a retry budget (RU-58).
- **I15.** Every `reply.<uuid>` channel opened by a jump attempt is unregistered when that attempt ends, whatever the outcome (RU-62a).
- **I16.** A flow with no resilience at any level runs the 0.9.0 step code path and produces the 0.9.0 graph JSON (RU-70).
- **I17.** A profile never shares breaker, bulkhead or bucket state between two subjects (RU-53b).
- **I18.** A jump wait is never unbounded (RU-62b).

## 7. Observability and sensitive data

### 7.1 Events

The events are listed in section 3.1. One event is emitted per decision, and valve events only on a state change. Events carry no payload, header, URL or raw key. The events channel is pubsub, in memory, and per pod. Durable shipping is out of scope; apps subscribe and forward.

### 7.2 Metrics (names for a Prometheus-style port; the port decides the exporter)

| Metric | Type | Labels |
|---|---|---|
| `estela_care_calls_total` | counter | edge, binding, outcome (`success`, `failure`, `plan-b`, `turned-away`) |
| `estela_care_call_seconds` | histogram | edge, binding, outcome |
| `estela_care_tries_total` | counter | edge, binding, class (`success` or a FailureClass) |
| `estela_care_extra_tries_total` | counter | edge, binding |
| `estela_care_turned_away_total` | counter | edge, binding, reason (TurnedAwayKind) |
| `estela_care_valves_shut` | gauge | edge, binding (count of shut keys) |
| `estela_care_shared_state_lost` | gauge | edge, binding (0 or 1) |
| `estela_care_tries_left_invalid_total` | counter | edge |

Bucket boundaries are the port's choice. SPI-437 (OTel) may bridge this port, and nothing here depends on it.

### 7.3 Threat model (resilience-owned sinks only)

| In scope (Estela resilience writes it) | Rule |
|---|---|
| Events, log lines, error messages | No payload, header, URL query or raw key. Keys go through `keyLabel` (RS-43, RS-44). |
| Metrics labels | No key label. Bounded cardinality: edge, binding, class, reason, outcome. |
| State-port keys in Redis | `estela:care:<part>:<binding>` for the default key, and `estela:care:<part>:<binding>:<keyHasher(key)>` for a custom key. A custom key with shared state and no `keyHasher` is refused at boot (RS-43). |
| Retry-budget header | An integer only. It is client-controlled, but it can only lower retries (RS-31). Gateways MAY strip it at the edge. |
| Graph summary | No thresholds, limits, keys or URLs (RS-42). |
| Testing helpers (`collectCareEvents`) | They capture events only, so they hold the same data as above. |

**Out of scope, with guidance.**
- **Heap dumps.** They hold live keys and payloads. Restrict access to them.
- **APM and OTel exporters outside Estela.** Configure their redaction there.
- **Nest's own exception logs.** A `PlanBFailedError` or `ValveShutError` that reaches Nest's default filter is logged with its stack and `cause` chain, and the `cause` may be an upstream error whose message echoes a body. Apps map Estela errors in an exception filter. The README states this.
- **The payload sinks of the sensitive-data spec.** These are hop logs, history, idempotency store, saga ledger and wire-tap, and they belong to SPI-433.

**Brute force of low-entropy keys.** A key built from a phone number or a short id has little entropy, so an unsalted digest can be reversed by enumerating the space (about 10^10 for E.164 numbers in one country). Anyone who can read Redis or the events could do it. The library therefore has no unsalted digest: a custom key reaches Redis only through `keyHasher`, and it reaches events only through `keyLabel` (RS-43). The library cannot tell whether a `keyHasher` is keyed. The README states that it MUST be an HMAC with a secret of at least 32 bytes, for example the SPI-433 `hash` mode. A truncated HMAC still resists enumeration only while the secret stays secret.

**Rotating the HMAC secret.** It changes every digest, with these effects:
- **Shared buckets restart full.** Each key's bucket starts again at `burst`, so there is a one-time burst of up to `burst` extra attempts per key.
- **Shared open markers are lost.** Open breakers in other pods close until failures are counted again.
- **Event and metric labels change.** Dashboards and alerts keyed on old labels break.

- **Manual quota openings are lost.** A breaker forced open with `onQuota: OnQuota.ShutUntilResumed` and shared state reopens only on the next quota failure, so one call reaches the provider per pod.

Rotate during low traffic, and keep the old secret for one `shutMs` if continuity matters. This rotation guidance is documentation only: the library holds a single hasher.

## 8. Failure and interaction matrix

| Situation | Outcome |
|---|---|
| Boot: invalid number, unknown class, both legacy and new on the same layer, disallowed primitive, fallback channel missing | `CareConfigError` (or `SagaDefinitionError`) at boot; no traffic |
| Key function throws or returns `''` or a string over 200 characters; `keyHasher` or `keyLabel` throws or returns an invalid value | `CareKeyError`; 0 dependency calls; not retried; fallback never triggered |
| Custom key with shared state and no `keyHasher` | `CareConfigError` at boot |
| `requireIdempotencyKey` and a non-safe call with no key | `CareKeyError('idempotency-key-required')`; 0 dependency calls |
| Ad-hoc `request()` options with a breaker, bulkhead or rate limit | `CareConfigError` on the first call; module-default ones are skipped for ad-hoc calls, with one warn line |
| Half-open probe admitted, then rate limited or cut by the deadline | probe slot freed, state unchanged |
| Breaker opens during the backoff of a retrying call | `ValveShutError { cause: previous attempt's error }` |
| Attempt cut by the deadline (not by `eachTryMs`) | not recorded by the breaker; `OutOfTimeError` |
| Breaker forced open by quota, next calls | `ValveShutError { forcedBy: 'quota' }`; fallback only if `'quota'` is in `on`; with `OnQuota.ShutUntilResumed`, no probe until `resume` |
| `maxKeys` reached for rate-limit buckets | least recently used bucket evicted; it restarts full (R5) |
| Activator retry with an outbound call inside that throws `ValveShutError` | `'rejected'` by the in-process classifier; not retried by the activator |
| Classifier throws | class `'unknown'`; error logged once; not retried |
| Breaker open, no fallback | `ValveShutError` (`readyInMs` = time to half-open); REST `mapError` receives it |
| Breaker open, fallback ok | fallback value, `planB: true`, `plan-b.used` |
| Breaker open, fallback throws | `PlanBFailedError { cause: fallbackError, original: ValveShutError }`, `plan-b.failed` |
| Half-open, probe in flight, second call | `ValveShutError` |
| Half-open probe ends `'rejected'` (400) | not recorded; probe slot freed; state stays half-open |
| 429 with `Retry-After` <= `maxServerWaitMs`, attempts left | wait `max(backoff, Retry-After)`, retry; breaker not touched |
| 429 with `Retry-After` > `maxServerWaitMs` | final; `OutboundHttpError(429)` (or fallback when `'busy'` is in `on`) |
| 429 classified `'quota'` by the app | final, breaker forced open, no fallback by default, `quota.used-up` |
| Timeout on a POST without a key | final after 1 attempt (outcome unknown) |
| Deadline expires during backoff, bulkhead queue or rate-limit wait | `OutOfTimeError { cause: last error or undefined }`; slot released |
| Deadline shorter than `eachTryMs` | the attempt gets the remaining deadline; boot warning |
| Bulkhead full, queue full | `LanesFullError(reason 'full')` |
| Bulkhead queue wait > `waitlistMs` | `LanesFullError(reason 'waitlist-expired')` |
| Rate limited, `waitMs` 0 | `OverPaceError { readyInMs }` |
| State port throws or is slower than `sharedStateWaitMs` | degraded local state for that binding, `shared-state.lost`; the call proceeds under the local limit; never unlimited |
| State port back | the next probe switches back, `shared-state.back`; any token debt is not reconciled (R6) |
| Shared open marker present, local breaker closed | rejected (`ValveShutError`) until `untilMs` |
| Two pods race for the half-open probe | exactly one holds the lease; the other rejects |
| Incoming `x-tries-left: 0` | single try; `try.held` when `tries.max > 1` |
| Incoming tries left invalid (`-1`, `abc`, `1.5`) | treated as absent; `estela_care_tries_left_invalid_total` +1 |
| Activator with retry and no key, not idempotent | 1 attempt, `try.held`; boot warning |
| Activator method ignores the abort signal and times out | the engine returns `overdueError`; the method keeps running (orphan); the slot is released (R4) |
| Activator idempotency plus retry | `begin` once, attempts inside, `complete` or `fail` once |
| Inbound shed (429) with an idempotency key | no claim taken; a client retry with the same key runs normally |
| Inbound idempotency in flight, `onInFlight: 'reject'` | unchanged (409 from the app's filter); shedding happened earlier only if over the limit |
| `onDuplicate: 'replay'` and the first answer was a fallback (at any depth of the same request) | inbound and activator claims released (or failed); the duplicate re-executes (RS-27) |
| Inbound `x-tries-left` present, module without `forRoot({ care })` | ignored; no `triesLeft` header on any message |
| Budget scope active, message sent to a `queue` channel | the message carries `triesLeft`; the consumer rebuilds the scope from it (RS-29) |
| SPI-433 `storeMode` and fallback | no `storeMode` stores a fallback result (RS-27); other replay interactions belong to the `SD-` spec |
| Saga outbound fails after the policy gives up | compensation unit, then the last error is rethrown (0.9.0 order) |
| Saga outbound step `ValveShutError` | same as any outbound failure: compensation, then rethrow |
| Events subscriber or metrics port throws | swallowed; warn at most once per minute; the call outcome is unchanged |
| Event raised inside a handler of the events channel | dropped (no loop) |
| `maxKeys` reached, all open or probing | the new key runs with an unstored closed breaker that records nothing; map size unchanged; `valve.keys-full` (rate limited) |
| Legacy `retry` binding receives `x-tries-left` | ignored (alias semantics) |
| Unknown profile in a step, flow, channel, default or decorator | boot fails; one error lists every `UNKNOWN_PROFILE` finding; no channel has a subscriber |
| Profile `extends` cycle, or chain deeper than 8 | `PROFILE_CYCLE` / `PROFILE_DEPTH` at boot |
| `care` passed to `wireTap` from JavaScript | `FlowDefinitionError(WIRETAP_CARE)` when the flow is built |
| Jump target with both `timeoutMs` and `care.patience.eachTryMs` | `LEGACY_AND_NEW_SAME_LAYER` at boot |
| `planB` on `fanoutTo`, `publish` or `route` set at L4 | `CARE_PART_NOT_ALLOWED` at boot; inherited from L1..L3: dropped, one warning |
| Flow step with retry, no key, no key resolver, not `idempotent` | 1 attempt, `try.held`; `TRIES_WITHOUT_KEY` at boot only when the flow claim is off (`FlowOptions.idempotency: false`) |
| Jump attempt times out, reply arrives later | the late reply hits an unregistered channel and is dropped; the next attempt has its own reply channel |
| Jump retry toward a keyed activator whose first run is still in flight | the activator treats the new attempt as a duplicate and answers only with a stored `cachedResult` (`activator-wrapper.ts:85-90,160-174`); until the first run completes with a defined result, every retry times out (R14) |
| Jump plan B answers | `jumpReplies[channel]` = plan B value, `jumpPlanB[channel] = true`; flow and step claims released or failed, never completed |
| Jump reply carries header `planB: true` | the flow scope is marked; the flow claim is released or failed |
| `wait: false` target exhausts its retries | exactly one `{ fireAndForget: true, channel }` envelope on `error.channel`; no fallback |
| Timeout then retry toward a `pubsub` destination | every subscriber receives the hop again (gated by RS-60, R15) |
| `queue` destination full | `CapacityExceededError`, class `'busy'`, retried after the backoff if RS-60 allows |
| `route` returns an unregistered channel | `ChannelNotFoundError`, class `'rejected'`, no plan cached for that name |
| Channel policy retries and so does its activator | `TRIES_STACKED` at boot; the sender claims the budget, so the activator makes one attempt per send attempt |
| Shutdown during a background (`wait: false`) retry sleep | no further attempt; the last error is reported once, best effort |
| `planB` from `defaults['saga-outbound']` | dropped with one warning; set on the step itself: `SagaDefinitionError` |
| Flow claim on a degraded run with a store that lacks `release` | `fail` is called; a redelivery runs again |

## 9. Non-functional requirements

- **Zero runtime dependencies** (RS-05). Only Node >= 18 core is used: `performance.now`, `AbortController`, `node:crypto`, `node:async_hooks`.
- **Overhead.** A binding without `care` runs the 0.9.0 code path and adds no awaits. The cost of each primitive is **measured in SPI-444** (benchmark harness). SPI-444 sets the budgets and decides the final `sharedStateWaitMs` default. No number is set here.
- **Memory.** It is bounded by `valve.maxKeys` and `pace.maxKeys` per policy. Bulkhead queues are bounded by `waitlist`.
- **Timers.** Only the injected clock is used. No timer survives shutdown.
- **Types.** The emitted `.d.ts` parses on TS 4.9.
- **Repo gates.**
  - The complexity and clone caps of section 4.
  - `npm run comments:en` passes on every touched file.
  - `npm run verify` is green.
- **Determinism.** Every unit test drives time through `manualCareClock` and randomness through `random`.

## 10. Test plan

Test ids (`RU-01`, `RE-01`, ...) are local to this spec. The multi-replica spec uses its own ids
(`RU1`, `RE1`); outside this file cite these as `RS:RU-01`.

### 10.1 Unit tests (`src/resilience/*.spec.ts` and the touched modules' specs; no network)

- **RU-01** `runs a care with no part as one direct try`
- **RU-02** `composes plan B > total patience > lanes > extra try > valve > pace > eachTryMs in that order`
- **RU-03** `rejects invalid profiles at declaration with the option path and collects every boot finding into one error` (table over section 5.6)
- **RU-04** `replaces each part whole from the highest level (call > step > flow > channel > module > built-in), deep-merges a reference once, false disables, and legacy aliases keep the field-by-field rule`
- **RU-05** `depcruise forbids npm imports under src/resilience` (a fixture file under `test/fixtures/`, run by `npm run bounds`)
- **RU-06** `aborts the try signal and rejects even when work ignores it`
- **RU-07a** `caps each try at the remaining total patience`
- **RU-07b** `never sleeps or queues past the total patience`
- **RU-08** `extra tries only classes in tries.on while tries, tries left and total patience remain`
- **RU-09a** `does not extra try a non-repeatable operation, including after a eachTryMs`
- **RU-09b** `sends the same idempotency key on every try`
- **RU-10** `computes exponential spacing with full spread from the injected random`
- **RU-11a** `waits max(spacing, Retry-After)`
- **RU-11b** `treats Retry-After above maxServerWaitMs as final`
- **RU-11c** `ignores invalid Retry-After values`
- **RU-12** `never extra tries engine rejections`
- **RU-13a** `runs app classifiers first, first defined wins`
- **RU-13b** `treats a throwing classifier as unknown and logs once`
- **RU-14** `maps REST failures per the default table`
- **RU-15** `maps every gRPC status code per the default table`
- **RU-16a** `quota is final, forces the valve open and skips the default plan B`
- **RU-16b** `default classifiers never return quota`
- **RU-16c** `manual quota opening never probes until resume`
- **RU-16d** `shut-for keeps a quota shut for quotaShutMs, then lets one probe through`
- **RU-16e** `resolves each onQuota mode to its shut length`
- **RU-16f** `refuses quotaShutMs without shut-for, shut-for without it, and unknown modes`
- **RU-17** `busy is tried again but not recorded by the valve`
- **RU-17a** `in-process classifier maps outbound, retryable and inner care errors per the table`
- **RU-18a** `opens at the failure rate after minCalls in a count window`
- **RU-18b** `opens in a time window and probes after shutMs`
- **RU-19** `limits probing probes and closes or re-opens on their outcome`
- **RU-20a** `evicts only closed valves when maxKeys is reached`
- **RU-20b** `fails with CareKeyError before any try when the key function throws`
- **RU-21** `lanes admits count, queues FIFO and always releases the slot`
- **RU-22a** `token bucket refills on the monotonic clock and reports readyInMs`
- **RU-22b** `extra tries consume tokens`
- **RU-24a** `degrades to a bounded local limit when the state port is down`
- **RU-24b** `probes the state port and recovers with one event per transition`
- **RU-25a** `runs the plan B for triggers in on and marks the result`
- **RU-25b** `does not run the plan B for rejected, quota or unknown by default`
- **RU-26** `wraps a failing plan B in PlanBFailedError with cause and original`
- **RU-27** `activator and flow claims are released, not completed, when a plan B ran during the message`
- **RU-29a** `reads the tries left from header, message and scope only when care is enabled`
- **RU-29b** `a message sent to a queue channel under a tries left scope carries triesLeft and the consumer rebuilds the scope`
- **RU-30a** `a retrying layer claims the tries left for downstream and nested executors`
- **RU-30b** `a non-retrying layer forwards the incoming tries left`
- **RU-31** `treats invalid tries left as absent and caps at 20`
- **RU-32** `emits extra try.suppressed once when the tries left removes extra tries`
- **RU-34** `legacy extra try and timeoutMs aliases produce identical tries, delays, errors and headers`
- **RU-35** `refuses legacy and care options for the same part on one layer`
- **RU-36a** `activator extra tries only when idempotent or keyed, inside one idempotency claim`
- **RU-36b** `exposes the try signal through currentTrySignal`
- **RU-37** `inbound accepts only lanes and pace and refuses Rabbit`
- **RU-38a** `saga outbound step extra tries, then compensates once, then rethrows`
- **RU-38b** `saga outbound step refuses plan B and non-idempotent extra try`
- **RU-39** `executor runs every part through a fake edge adapter`
- **RU-40a** `event publishing failures never change the call outcome`
- **RU-40b** `events raised while handling the events channel are dropped`
- **RU-41** `metrics carry no key label and swallow port errors`
- **RU-42** `graph shows the care summary and omits the field without a care`
- **RU-43a** `raw keys never reach events, logs, metrics, errors or state keys`
- **RU-43b** `keyLabel and keyHasher outputs are used when configured and invalid outputs fail with CareKeyError`
- **RU-43c** `a custom key with shared state and no keyHasher fails boot`
- **RU-44** `error messages carry binding, kind and tries only`
- **RU-45** `logs one line per state transition and none per successful call`
- **RU-46** `care errors keep instanceof across the main and testing bundles` (in `test/dist-identity.spec.ts`)
- **RU-47** `engine timers use only the injected clock`
- **RU-48** `requireIdempotencyKey rejects a non-safe call without a key before any try`
- **RU-49** `resume closes a manual quota opening and clears the shared marker`
- **RU-50** `multi replica mode reports process-local pace limiters and valves` (in the replica-guard spec file once SPI-429 has merged)
- **RU-51** `resolves each part from the highest level that sets it, with the destination channel as L2 for send steps`
- **RU-52** `deep-merges inline fields over a named profile once and replaces whole parts across levels`
- **RU-53a** `resolves extends chains and fails boot on cycles, depth over 8, bad names and unknown names`
- **RU-53b** `gives every subject its own valve, lanes and bucket when they share a profile`
- **RU-54** `applies care.defaults per edge kind and refuses defaults.inbound and a second L1 source for outbound-rest`
- **RU-55** `flow options apply per step family and never to wireTap, filter, transform or reply`
- **RU-56** `channel care applies to senders into the channel and activators on it, never to inbound or to handle steps`
- **RU-57** `step ids, duplicate ids, per-target overrides, the publish overload and refusal on filter, transform and reply`
- **RU-58** `wireTap refuses care, skips defaults and strips triesLeft from the copy`
- **RU-59** `drops parts inherited from L1..L3 that an edge refuses and fails boot when L4 sets them`
- **RU-60a** `a flow step extra tries only under a message key, a key resolver or idempotent: true`
- **RU-60b** `warns TRIES_WITHOUT_KEY and TRIES_STACKED once at boot and honours requireIdempotencyKey`
- **RU-61** `a send try resends an identical hop copy, route runs its function once, one flow hop pair per run`
- **RU-62a** `a jump try opens a fresh reply channel, always unregisters it, and drops late replies`
- **RU-62b** `legacy jump timeoutMs aliases eachTryMs, both on one target fail boot, and the wait is never unbounded`
- **RU-62c** `wait:false targets extra try in the background, refuse plan B, report one final failure, and start no try after shutdown begins`
- **RU-63** `flow adapters classify channel errors by name per the section 5.7 table`
- **RU-64a** `a jump plan B lands in jumpReplies with jumpPlanB and the flow claim is not completed`
- **RU-64b** `a handle plan B becomes the payload, a plan-B-marked jump reply header marks the flow scope, and a plan-B-marked flow's reply step sets plan-B-marked: true`
- **RU-65** `a retrying flow step stamps triesLeft 0 on its hops and a non-retrying step forwards the tries left`
- **RU-66a** `flow edge events and metrics use the step subject and never a payload value`
- **RU-66b** `graph shows step id, care and repeatableBy only on configured steps`
- **RU-67** `FlowParameterResolver collects every finding, throws once, and runs before activators bind`
- **RU-68** `call-level care refuses stateful parts, care false, and timeoutMs plus care.patience on one call`
- **RU-69** `a nested executor in the same async chain caps its total patience at the outer one, and a legacy-alias plan ignores it`
- **RU-70** `flows without any care configuration behave as in 0.9.0` (plus the existing specs listed in RS-70, unmodified)
- **RU-71** `activator, inbound, saga and bindGrpcOut accept references within their edge limits`

### 10.2 End-to-end tests

- **RE-01** (`test/resilience.e2e.spec.ts`) `outbound rest binding extra tries 503s, calls mapError once and logs one hop`. This test uses a real loopback HTTP server.
- **RE-02** (same file) `inbound pace answers 429 with Retry-After before the idempotency claim, and an inbound x-tries-left of 0 stops downstream extra tries`.
- **RE-03** (same file) `two in-process apps chained over HTTP: the failing leaf receives at most tries.max calls`.
- **RE-04** (`test/resilience-redis.e2e.spec.ts`, skipped unless `ESTELA_REDIS_URL`) `two engines share one token bucket under Redis server time`.
- **RE-05** (same file) `shared open marker rejects on the other engine and only one engine holds the probing lease`.
- **RE-06** (`test/resilience.e2e.spec.ts`) `a plan B answer is not replayed for a duplicate idempotency key`. The fallback runs in an outbound binding called by the activator, so the degraded mark crosses the activator and the reply gateway.
- **RE-07** (same file) `an invalid care option fails module boot`.
- **RE-08** (`test/resilience-flow.e2e.spec.ts`) `a keyed flow whose jump answers with plan B runs again for a duplicate key, and the jumped activator's plan-B-marked reply marks the flow`. It uses a real `IntegrationModule.forRoot` with profiles, a flow with `jumpTo` and an activator that calls a failing loopback REST binding.
- **RE-09** (same file) `profiles referenced from a channel, a flow, a step and an activator boot and resolve per subject; a misspelled profile fails boot with every finding listed`.

Local Redis target for RE-04 and RE-05 is `ESTELA_REDIS_URL=redis://localhost:6380`. AGENTS.md gets the same paragraph the Postgres e2e has.

## 11. Documentation to update

- **README "Outbound REST: request/reply with your own contract".**
  - Replace the caveat "`Retry-After` is not honoured" with a pointer to the new section.
  - Document that `timeoutMs` and `retry` are aliases of `care`.
  - Add a migration table (section 1).
- **New README section "Resilience".**
  - The model and the composition order.
  - The classification table and the 429, breaker and quota matrix.
  - The retry budget, with a guidance box: put retries on the edge closest to the dependency, and give activators only a bulkhead and timeouts.
  - Shared state with the ioredis and node-redis `evalScript` snippets, and D-REDIS-DOWN behaviour.
  - Events, metrics and keys (D-PHONE guidance: `keyHasher` MUST be an HMAC with a secret of at least 32 bytes; configure a hashing `keyLabel` when keys may be personal).
  - `tries.requireIdempotencyKey`, `valve.onQuota` (`OnQuota`) and `CareControl`.
  - The degraded mark: a fallback answer is never replayed by idempotency (RS-27).
  - Budget migration: legacy `retry` bindings do not take part in the retry budget (R11).
  - Inbound 429 and the `RESOURCE_EXHAUSTED` mapping (an app filter snippet until SPI-431 lands).
- **New README section "Flow care".** Levels and precedence, profiles (`profiles`, `extends`, `use`), `defaults` per edge kind, `FlowOptions`, the per-method table, jump semantics (late replies, legacy `timeoutMs`), the flow classification table, the degraded mark in flows, and a link to the shared flow parameter model.
- **README "Observability".** Graph policy summaries and the new boot-log suffix (`outbound rest: payments.http -> POST https://pay.example/charges [tries x3 · valve]`).
- **Translations.** `README.es.md`, `README.pt.md` and `README.fr.md` follow the release's translation process. They are not blocking for this ticket, which keeps the English README authoritative.
- **AGENTS.md.**
  - Commands: the `ESTELA_REDIS_URL` gated e2e.
  - Layer boundaries: `resilience-no-npm` and `resilience-is-leaf`.
  - Adding features: "New resilience edge -> `CareEdgeAdapter`; never a private retry loop"; "New shared-state backend -> `CareStatePort`".
  - Testing rules: `manualCareClock`, `MemoryCareState`, `collectCareEvents`.
- **Skills.**
  - `skills/estela-setup`: `forRoot({ care })`, the state port and the metrics port.
  - `skills/estela-flows`: policies on bindings, activators, inbound and saga steps; flow options (`from(source, options)`), step and target options, channel `care`, named profiles and `use`, and the per-method table of section 2.13.
  - `skills/estela-testing`: the clock and fault injection on the state port.
  - `skills/estela-review`: checklist items:
    - no hand-written retry loop around an Estela call;
    - retries live on one layer;
    - no fallback that hides a side-effect failure;
    - keys of personal data are hashed with a keyed `keyHasher`, never a plain digest;
    - side-effecting bindings set `requireIdempotencyKey`;
    - no `'busy'` in `countOn` without a reason;
    - inbound limits sit before idempotency;
    - no flow step retry without an idempotency key or a written reason for `idempotent: true`;
    - no retry toward a `pubsub` destination unless every subscriber is idempotent;
    - a jump retry toward a keyed activator has `eachTryMs` longer than the activator's work (R14);
    - a channel policy and its activator policy do not both retry (`TRIES_STACKED`).
- **CHANGELOG.** Written by the release tooling. Never bump the version by hand.

## 12. Dependencies on other tickets

```text
SPI-445 (this) ──provides executor + adapter contract + gRPC classifier──▶ SPI-430 (OutboundGrpcGateway)
SPI-445 ──provides executor + adapter contract──────────────────────────▶ SPI-436 (SDK outbound)
SPI-445 ──InboundBusyError.grpcCode──────────────────────────────▶ SPI-431 (command inbound status mapping)
SPI-433 (sensitive data) ──masker "hash"/"partial" as keyLabel/keyHasher──▶ SPI-445   (soft: RS-43 works without it, keys omitted)
SPI-429 (multi-replica) ──IdempotencyStoreUnavailableError, boot guard────▶ SPI-445   (soft: section 5.4 references; RS-50 waits for the guard)
SPI-445 ──RS-48 requireIdempotencyKey, RS-49 resume, RS-16 quota class, event names──▶ Koletz adoption spec (KA-)
SPI-432 (graph exposure) ──governs who sees policy summaries─────────────▶ SPI-445   (soft)
SPI-444 (benchmarks) ◀──measures primitive overhead, sets sharedStateWaitMs and perf budgets── SPI-445
SPI-437 (OTel) MAY bridge CareMetricsPort; no dependency either way
SPI-434 (broker channels): deferred; the budget header rides message headers when it lands
SPI-435, SPI-438..443: independent
Shared flow parameter model (SPI-433, SPI-429, SPI-445, KA-) ──levels, refs, FlowParameterResolver──▶ SPI-445 section 2.13
SPI-429 ──StepIdempotencyOptions, step claim, StoreRef, IdempotencyStore.kind──▶ SPI-445 RS-60, RS-64   (soft: the message-key gate works without them)
SPI-433 ──SensitiveRef on StepCommonOptions/FlowTarget/ChannelSpec──▶ same DSL signatures   (SPI-433 lands first and adds the shared option types and resolver skeleton, SD-67)
SPI-445 ──profile names (policies)──▶ Koletz adoption spec (KA-): reference profiles by name only
SPI-430 ──bindGrpcOut replies on headers.replyChannel (KA Q17)──▶ RS-62 flow-jump to a gRPC binding   (soft: until then an awaited jump to a bindGrpcOut channel times out)
SPI-433, SPI-429 ──SD-55, MR-47 findings──▶ RS-67 class rule and FlowParameterFinding (one resolver, one throw)
```

### Agreed delivery order (identical in the four SPI-428 specs)

1. **SPI-433 sensitive data (P0)** ships first. With SPI-432 (graph control, P0) it gates the first
   Koletz adoption step (A1).
2. **SPI-429 multi-replica (P1).** Its boot guard is released and enabled in Koletz (KA-01, KA-02)
   before any service runs more than one replica or an HPA; until then the Koletz CI check KA-03
   blocks scaling. It does not gate A1.
3. **SPI-445 resilience** after SPI-429, so RS-50 lands with the guard instead of as a follow-up;
   SPI-430 and SPI-436 merge after it or rebase onto it.
4. **Koletz adoption (KA-)**, gated by the P0 items: A1 by SPI-433 + SPI-432; A4 by SPI-433 +
   SPI-431; A3 by SPI-445 (plus SPI-430 / SPI-436 for gRPC and SDK hops); A7 (shared store, scaling
   allowed) by the SPI-429 stores.

The build-time dependencies between the three library tickets stay soft (none blocks another); the
order above is the release plan, not a code dependency.

Notes on that order:
- SPI-445 has no build-time blocker and work on it can start now; it is released third.
- SPI-430 and SPI-436 consume it, so they should merge after it or rebase onto it.
- SPI-433 is not a blocker. RS-43's default (custom keys omitted; shared state refused without a `keyHasher`) is safe without it.
- SPI-429 is not a blocker. Only the SHOULD RS-50 waits for its guard.

## 13. Risks (accepted, documented)

- **R1. Outermost retrier.** The budget rule makes the outermost retrying layer own the retries. If that layer is an activator wrapping several calls, a retry re-runs all of them. The guidance is to retry at the edge closest to the dependency. `triesLeft: 'forward'` exists but allows amplification.
- **R2. Per-pod failure counting.** A shared breaker shares only the open decision. With N pods, each pod needs `minCalls` before it can open, so detection is slower than with fully shared counters, but no write-per-call to Redis is needed. Revisit after SPI-444 if detection is too slow.
- **R3. Degraded limiter overshoot.** While degraded, the effective global limit is `pods x soloPerSecond`. With the default `replicas: 1`, that is N times the configured limit. Services that run several pods must set `replicas`. RS-50 reports `REPLICAS_HINT_DEFAULT` through the SPI-429 guard in `multi` mode.
- **R4. Orphaned work.** A per-attempt timeout stops waiting but cannot stop code that ignores the `AbortSignal`. Activator methods and SDK calls may keep running, and the bulkhead slot is freed when the engine returns, so the real concurrency can briefly exceed `count`. Methods should read `currentTrySignal()`.
- **R5. Key cardinality.** A key derived from attacker-controlled input can churn the LRU, evict legitimate closed breakers, and evict rate-limit buckets, which restart full. `maxKeys` bounds memory, not fairness. Keys should come from server-side ids (organization, provider).
- **R6. Token debt after recovery.** Tokens taken locally while degraded are not reconciled with Redis on recovery. The shared bucket may grant up to `burst` extra right after recovery.
- **R7. HMAC rotation.** See section 7.3.
- **R8. Weak `keyHasher`.** The library requires a `keyHasher` for custom keys in shared state, but it cannot verify that the hasher is keyed. A plain hash would be reversible by enumeration. Mitigation: README guidance and the `estela-review` skill checklist.
- **R11. Legacy bindings break the budget chain.** A binding that still uses the `retry` alias neither reads nor forwards `x-tries-left` (section 1), so it can retry under a budget of 0, and a downstream layer sees no budget. The retry-amplification guarantee (I4) holds only after a service migrates its bindings to `care`. The migration is the consumer's job (the Koletz adoption spec does it binding by binding with an equivalence test).
- **R12. Shared breaker visibility.** Only pods that read a shared open marker (within `syncMs`) treat the key as open or half-open. A pod that never saw it stays closed and counts its own failures. This is accepted with D11.
- **R13. The plan B mark depends on in-pod request/reply.** The reply header `planB` crosses only in-process reply channels. A reply that leaves the pod is SPI-434 and is out of scope (MR-31).
- **R9. Inbound shedding runs after guards.** Authentication cost is paid before shedding. This is accepted: shedding after authentication keeps an unauthenticated flood from consuming a tenant's budget.
- **R14. Jump retry against a keyed downstream claim.** A jump attempt that times out leaves the downstream activator running under its claim. The next attempt, with the same `idempotencyKey`, is a duplicate for that activator, which answers only with a stored `cachedResult` (section 0.1). Until the first run completes with a defined result, every retry times out. Mitigation: `eachTryMs` longer than the downstream work, a `totalMs` that leaves room for one full run, and the `estela-review` checklist.
- **R15. Retry toward pubsub duplicates delivery.** A `pubsub` send never rejects for a subscriber failure, so only a timeout fails it, and a retry delivers to every subscriber again. RS-60 gates it, but every subscriber must be idempotent.
- **R16. `handle` input reused across attempts.** Estela passes the same input message to each attempt and does not deep-copy it. A `fn` that mutates its input sees its own changes on the next attempt (as with saga `ctx`, RS-38).
- **R10. gRPC "unknown" codes.** Not retrying `INTERNAL` and `UNKNOWN` by default may surface transient server bugs to callers. This is deliberate: retrying unknown failures is the classic amplification path.

## 14. Decisions log

| # | Question | Decision | Reason |
|---|---|---|---|
| D1 | Native engine or a library | Native engine, zero dependencies | Graph, trace, idempotency gating and budget awareness need to sit inside Estela, and the zero-dependency rule holds |
| D2 | Keep a `ResilienceEngine` port and a cockatiel adapter | Dropped; future work only | No consumer needs a second engine (finding 8). A port without a second implementation is speculative |
| D3 | Composition order | fallback > deadline > bulkhead > retry > breaker > pace > timeout | Retries must take tokens and be seen by the breaker. One bulkhead slot per logical call, so retries do not multiply concurrency. The deadline covers queueing. This replaces the earlier draft's order, where retry sat inside the breaker and the limiter |
| D4 | Classifier output | `FailureClass` (5 values) plus an optional `readyInMs`, not a boolean | One verdict drives retry, breaker and fallback consistently, and it resolves the 429, breaker and quota contradiction (section 5.3) |
| D5 | 429 and the breaker | `'busy'`: retried with `Retry-After`, not recorded | The callee is healthy. Throttling must not turn into an outage |
| D6 | Quota | A generic class that only app classifiers produce: final, forces the breaker open, no default fallback | Provider rules (guardrail 9) are Koletz policy and live in the `KA-` spec |
| D7 | Who retries | The outermost retrying layer claims the retry budget (`x-tries-left: 0` downstream, scope 0 in-process) | Linear instead of exponential amplification, with no response-side signal needed. Deterministic across processes |
| D8 | Budget on legacy aliases | Ignored, header not sent | The aliases have identical semantics (section 1) |
| D9 | Where inbound shedding sits | Before `next.handle()` and before the idempotency claim | A shed request must not hold a key, and the client retry must run |
| D10 | Fallback and idempotency | A fallback result is never cached unless `cacheable: true` | A degraded answer must not be replayed forever by `onDuplicate: 'replay'` |
| D11 | Shared breaker model | Shared open marker plus a probe lease; counts stay per pod | One Redis write per transition, not per call. Simple to degrade |
| D12 | Bulkhead slot release | When the engine returns | Releasing only when the underlying work settles would let a hung call that ignores the signal hold a slot forever. Accepted as R4 |
| D13 | Saga outbound fallback | Refused at definition | It would skip compensation and hide a failure |
| D14 | `mapError` and resilience errors | Widen the parameter type with `bivarianceHack`; only opt-in bindings produce them | Additive at compile time and unchanged at run time for existing bindings |
| D15 | Resilience errors as `OutboundRestError` subclasses | No; a separate `CareError` family | Extending `OutboundFailureKind` would break consumers' exhaustive switches |
| D16 | gRPC classifier location | Here, as a pure function on the code | SPI-430 can use it without re-specifying it, and it needs no `@grpc/grpc-js` import |
| D17 | Graph summary content | Kinds, timeouts and the number of attempts only | Thresholds and limits reveal capacity. Exposure is SPI-432 |
| D18 | Ticket scope | Activators, inbound shedding, the metrics port and events ship here, not under SPI-430/436/444 as the superseded draft mapped them | They share the executor and its tests. SPI-430/436 consume RS-39; SPI-444 only measures |
| D19 | Stateful primitives on ad-hoc outbound options | Refused | Ad-hoc plans live per options object (`WeakMap`), so an inline literal would get a fresh breaker on every call and could never open |
| D20 | Unsalted digest for state keys | None; `keyHasher` required for custom keys in shared state | D-PHONE and SD-15 (no unsalted fallback); an unsalted digest of a phone number is reversible |
| D21 | Where the plan B mark travels | Per-message `CareScope` plus reply header `planB: true` | `ReplyGateway` returns only payloads today; a header keeps the payload untouched |
| D22 | Default classifier of activators and saga steps | Structural `defaultInProcessClassifier` | With `'unknown'` as the only default, an activator retry would never fire; reading `retryable` reuses the flag SPI-429 and SPI-433 already set |
| D23 | Quota opening that must not reopen on a timer | `onQuota: OnQuota.ShutUntilResumed` (amended by D35; was `quotaShutMs: 'until-resumed'`) plus `CareControl.resume` | A consumer may need to close only on an external signal (for example a new credential version), and the library must not probe a quota-exhausted dependency |
| D24 | Merging across levels | Per-primitive replace, with a one-time deep merge inside one reference (shared model 1.2); legacy aliases keep the field-by-field rule | With six levels, a field merge makes the effective value impossible to read in one place; a level that sets a primitive states it whole. Amends RS-04; confirm in OQ-12 |
| D25 | Fallback on flow send steps | Refused, except `to` with `{ channel }` as a plain send | `fanoutTo`, `publish` and `route` continue or fan out and have no place for a substitute value; `to` ends the flow, so a reroute is meaningful |
| D26 | Where `FlowParameterResolver` runs | After boot step 1 (channels) and before step 2 (activators, outbound bindings) | Activators and bindings take profile names, so they need the frozen registry; flows (step 3) come later anyway |
| D27 | Hop identity across attempts | One hop per target per step execution; attempts resend an identical copy (a jump changes only `replyChannel`) | Downstream deduplication by `id` and key, as outbound REST builds its request once (section 0.1) |
| D28 | Classifying channel errors on flow edges | By error `name`, in the flow adapters, before `defaultInProcessClassifier` | No channel error carries `retryable`, so the in-process classifier alone would make every flow failure `'unknown'` and flow retries would never fire |
| D29 | A jump wait with no per-attempt timeout | Falls back to the remaining deadline, else to the 0.9.0 wait | An unbounded jump wait would leak a reply channel per hung target |
| D30 | Engine log sink (RS-45) | `src/resilience` writes through an injected `CareLogger` (`CareModuleOptions.logger`); `IntegrationModule` wires Nest `Logger('EstelaCare')`, and a standalone runtime logs nothing unless given one | `resilience-no-npm` (RS-05) forbids importing `@nestjs/common` under `src/resilience`; the module keeps the Nest logger name the spec asks for |
| D31 | Probing a degraded state port (RS-24) | Lazy: the first call after `sharedStateCheckMs` probes the port; no background timer | No timer can outlive a call or shutdown, so section 4 "Timers" holds without unref or cleanup hooks; `shared-state.back` is emitted on that call |
| D32 | Quota openings in shared state (RS-16, RS-23) | Written to a separate marker key `estela:care:valve:<binding>[:<hash>]:quota`; a pod reads both markers in one state call per `syncMs` | `markShut(key, untilMs)` carries no reason, and other pods must also report `forcedBy: 'quota'` and skip the default fallback; `resume` clears both keys |
| D33 | Public names not listed in section 3.9 | `TryOverdueError` (one in-process try ran past `eachTryMs`; classified transient), `CareEngine` (module-wide state; standalone gateways and saga runners create their own), the DI token `CARE_ENGINE`, `ReplyGateway.sendAndReceiveMessage` (the internal method of RS-27 that returns reply headers), `InboundTransportStrategy.rawHeaders` implemented by the built-in strategies, and `MemoryCareState.hang()` | Each is needed by an application point of this spec; all are additive |
| D34 | Estela-own vocabulary | Every public name of the feature uses the Estela vocabulary of section 18 (`care` with the parts `patience`, `tries`, `valve`, `lanes`, `pace`, `planB`; `CareError` family; `CareControl`; `CareEngine`; `try.again` and `valve.*` events; `estela_care_*` metrics; `x-tries-left` and `planB` headers; `care`/`repeatableBy` graph text; `CARE_PART_*`, `PLAN_B_*` and `TRIES_*` finding codes). There are no aliases for the earlier draft names, because they never shipped. The 0.9.0 names stay as they are. Without any care configuration, behaviour stays exactly 0.9.0 (RS-70, amended) | Owner decision 2026-11-10 (final vocabulary ruling): a flow author reads the names without the docs, they sit next to `sensitive`, `idempotency` and `profiles`, and they do not tie the public API to textbook or third-party library terms. Requirement IDs, file paths and this file name are unchanged |
| D35 | Quota behaviour of a valve (RS-16, RS-49) | Quota behaviour is an explicit enum to avoid a number\|string union: `valve.onQuota: OnQuota` (`ShutLikeFailure` default, `ShutFor`, `ShutUntilResumed`), with `quotaShutMs: number` required by `ShutFor` and refused otherwise. The resolved plan keeps `number \| 'until-resumed'` internally | Owner decision 2026-11-10: `quotaShutMs?: number \| 'until-resumed'` read as a duration that sometimes was not one. The enum names the three behaviours, and a JavaScript caller passing any other string fails at boot. Unreleased, so no alias for the union |
| D36 | Coupled fields inside `use` and `extends` (RS-53) | Inside one reference, a part's field that decides a sibling also clears the inherited sibling it does not set: `valve.onQuota` clears `quotaShutMs`; `valve.lookBack.lastCalls` and `lastMs` replace each other; `planB.value` and `planB.channel` replace each other. Without this, a child profile that only changed `onQuota` inherited the parent's `quotaShutMs` and failed boot. Test RU-53c. |
| D-PHONE | How keys holding phone numbers are shown in sinks | Customer numbers: `'hash'` (salted HMAC) via `keyLabel` and `keyHasher`. The platform's own business or sender numbers MAY use `'partial'` through the app's `keyLabel`. Without configuration, custom keys are omitted from events, metrics and logs, and shared state with a custom key is refused | Owner default 2026-11-09 (OQ-7) |
| D-REDIS-DOWN | Shared limiter or breaker state unavailable | Degrade to local per-pod state (never unlimited), emit `shared-state.lost`, probe and recover. Idempotency store unavailable: fail closed for side-effecting channels (the `MR-` spec owns it; section 5.4 only states how the engine classifies the error) | Owner default 2026-11-09 (OQ-7) |
| D37 | Where a flow care key reads a tenant or sender number (SPI-448 gap headers) | A flow puts routing keys in headers with the `headers(values \| fn)` step, and an inbound endpoint can copy an allowlist of transport headers with `carryHeaders`; `valve.key` and `pace.key` read `ctx.message.headers`. Neither writes `RESERVED_HEADER_NAMES` (trace, reply, idempotency, `triesLeft`, `planB`, jump bookkeeping). Care code is unchanged | The WhatsApp pipeline scenario had to keep `organizationId` and `businessNumber` in the payload because no step could add headers and the gRPC mapper copied trace headers only. Both options are opt-in; flows without them behave as before |

## 15. Open questions

| # | Question | Default until answered | Owner |
|---|---|---|---|
| OQ-1 | The Jira key of this ticket under SPI-428 | Resolved 2026-11-09: `SPI-445` (SD Q10 resolved with it) | ESTELA maintainer |
| OQ-2 | Is `replicas: 1` the right default, or should shared state require it explicitly? | 1, plus the R3 warning | ESTELA maintainer, with the Koletz platform owner |
| OQ-3 | `sharedStateWaitMs` (100) and the breaker defaults (50%, 10, 20, 30 s) | as written; revisited with SPI-444 data | ESTELA maintainer (SPI-444) |
| OQ-4 | Propagate the remaining deadline downstream (`x-request-deadline`, gRPC deadline)? | not propagated; SPI-430 sets the gRPC deadline from the remaining one | ESTELA maintainer |
| OQ-5 | Deprecate the `retry` and `timeoutMs` aliases before 1.0? | kept, no warning | ESTELA maintainer |
| OQ-6 | Per-key bulkheads (for example per tenant)? | not in scope | Koletz platform owner (demand) |
| OQ-7 | Confirm or override D-PHONE and D-REDIS-DOWN | the defaults in section 14 | Koletz platform owner |
| OQ-8 | Should `'busy'` trigger the fallback by default? | yes | ESTELA maintainer |
| OQ-9 | Redis client used as a devDependency for the gated e2e | `ioredis` | ESTELA maintainer |
| OQ-10 | The Koletz adoption spec used the event names `estela.resilience.quota_exhausted` and `state_degraded`, and the option `requireIdempotencyKey`. This spec defines the event types `quota.used-up` and `shared-state.lost` on channel `estela.care.events`, and `tries.requireIdempotencyKey`. Align the KA spec to these names | Resolved 2026-11-09: the KA spec uses `estela.care.events`, `quota.used-up`, `shared-state.lost` and `tries.requireIdempotencyKey` (KA-35), and `quotaShutMs: 'until-resumed'` (KA-29), since replaced by `onQuota: OnQuota.ShutUntilResumed` (D35) | Koletz platform owner |
| OQ-11 | Split this ticket into "engine plus outbound REST" and "activator, inbound, saga application points" if review finds it too large for one PR | one ticket, one PR. Section 2.13 (flows) is the most natural split point if one is needed | ESTELA maintainer |
| OQ-12 | Confirm the amended RS-04 merge rule (per-primitive replace across levels, from the shared model) instead of the original field-by-field merge | as amended (D24) | ESTELA maintainer |
| OQ-13 | Meaning of `care` in the graph: RS-42 renders a part summary (`patience 2s · tries x3`); the shared model renders the source (`jump-sla+inline`, `module:flow-jump`) | flow step targets carry the source label; outbound, inbound and activator refs keep the RS-42 summary; `describeCare` keeps returning the summary | ESTELA maintainer |
| OQ-14 | Two L1 sources for outbound REST (`care.defaults['outbound-rest']` and `outbound.rest.defaults.care`): refuse or rank? | refused at boot (RS-54) | ESTELA maintainer |
| OQ-15 | The shared model's level table names the flow source channel as L2 for `handle`; its channel section limits `ChannelSpec.care` to senders and activators. Does a source channel's `care` apply to `handle` steps? | no (RS-56) | owners of the shared model |
| OQ-16 | Where the shared flow parameter model document lives (the same question as SD Q12 and MR OQ-14) | referenced by name; it should be committed next to the four SPI-428 specs, and each spec links it | ESTELA maintainer |
| OQ-17 | Error for `care` passed to `filter`, `transform` or `reply` from JavaScript (the model names a code only for `wireTap`) | `FlowDefinitionError` with `CARE_PART_NOT_ALLOWED` | owners of the shared model |
| OQ-18 | The per-attempt timeout error of in-process edges (activator, saga outbound, `flow-handle`, `flow-send`) is not named in this spec | a `ChannelError` subclass with `retryable: true`, so `defaultInProcessClassifier` returns `'transient'`; `flow-jump` keeps `JumpTimeoutError` | ESTELA maintainer |
| OQ-19 | A `wait: false` jump writes its late reply into the `jumpReplies` object already held by the continued message (`jump.step.ts:34,38,72`). Keep this under a background retry loop? | kept as in 0.9.0; background targets refuse `planB`, so no degraded value is written | ESTELA maintainer |
| OQ-20 | A profile with `tries.methods` resolved onto a non-REST edge | refused at boot at `tries.methods` (RS-71) | ESTELA maintainer |
| OQ-21 | Keep `tries.idempotent: true` as a declared way around the key requirement (shared model 4.2(c)), or require a key only? | kept, logged at boot and shown as `repeatableBy: 'declared'`; removing it also changes RS-36 | owners of the shared model |
| OQ-22 | Ship section 2.13 in the same release as the rest of SPI-445? Widening `CareEdge` later breaks exhaustive switches | same release | ESTELA maintainer |
| OQ-23 | (SD 7.1 and MR section 16.5 take the same position) The shared model (section 5.2 there) runs `FlowParameterResolver` after boot step 1 and before step 3; RS-67 runs it before step 2, because activators and outbound bindings take profile names (D26). Amend the model? | before step 2 (RS-67) | owners of the shared model |
| OQ-24 | Accept boundary (KA Q8): should an inbound endpoint that answers before its work runs (fire-and-forget, or a `queue` channel) stop the incoming `x-tries-left` from reaching the asynchronous work? | not in SPI-445; adopters reset the budget themselves (KA D-ACCEPT-BOUNDARY) | ESTELA maintainer, with the Koletz platform owner |
| OQ-25 | `extends` shape: SD-48 lets a sensitive profile extend a list of names (unioned in order), while RS-53 keeps single inheritance, because a resilience merge is a deep-merge-once whose result would depend on list order | keep the difference; both count depth in hops (more than 8 fails) and use the same codes | owners of the shared model |

## 16. Definition of done

- Every MUST requirement (RS-01 to RS-71, including RS-17a; RS-32, RS-45, RS-50 and RS-69 are SHOULD) is implemented and covered by its named tests. The SHOULD items are implemented, or their deferral is recorded in the PR.
- The traceability table (section 17) has no requirement without a passing test name.
- `npm run verify` is green, the new depcruise rules are active, and `npm run comments:en` passes on every touched file.
- The existing outbound, activator, inbound and saga spec files, and the flow specs listed in RS-70, pass **unmodified** (section 1).
- The shared flow parameter model is committed and linked from section 2.13 (OQ-16), and every finding code used here matches it.
- `test/dist-typescript4.spec.ts` and the extended `test/dist-identity.spec.ts` are green on the built package.
- RE-04 and RE-05 were run locally against Redis, and the result is pasted in the PR (CI skips them).
- The README, AGENTS.md and skills are updated (section 11).
- The PR uses the template, the branch is `feat/SPI-445-resilience`, the change is a `feat` squash with no `BREAKING CHANGE` footer, and "Dependencies added" lists the Redis dev client.
- The SPI-430 and SPI-436 tickets are linked to this one as "is blocked by", with the RS-39 contract quoted.

## 17. Traceability

| Requirement | Tests | Ticket |
|---|---|---|
| RS-01 | RU-01 | SPI-445 |
| RS-02 | RU-02 | SPI-445 |
| RS-03 | RU-03, RE-07 | SPI-445 |
| RS-04 | RU-04 | SPI-445 |
| RS-05 | RU-05 | SPI-445 |
| RS-06 | RU-06 | SPI-445 |
| RS-07 | RU-07a, RU-07b | SPI-445 |
| RS-08 | RU-08 | SPI-445 |
| RS-09 | RU-09a, RU-09b | SPI-445 |
| RS-10 | RU-10 | SPI-445 |
| RS-11 | RU-11a, RU-11b, RU-11c | SPI-445 |
| RS-12 | RU-12 | SPI-445 |
| RS-13 | RU-13a, RU-13b | SPI-445 |
| RS-14 | RU-14 | SPI-445 |
| RS-15 | RU-15 | SPI-445 (wired by SPI-430) |
| RS-16 | RU-16a, RU-16b, RU-16c, RU-16d, RU-16e, RU-16f | SPI-445 |
| RS-17 | RU-17 | SPI-445 |
| RS-17a | RU-17a | SPI-445 |
| RS-18 | RU-18a, RU-18b | SPI-445 |
| RS-19 | RU-19 | SPI-445 |
| RS-20 | RU-20a, RU-20b | SPI-445 |
| RS-21 | RU-21 | SPI-445 |
| RS-22 | RU-22a, RU-22b | SPI-445 |
| RS-23 | RE-04, RE-05 | SPI-445 |
| RS-24 | RU-24a, RU-24b | SPI-445 |
| RS-25 | RU-25a, RU-25b | SPI-445 |
| RS-26 | RU-26 | SPI-445 |
| RS-27 | RE-06, RU-27 | SPI-445 |
| RS-28 | RE-03 | SPI-445 |
| RS-29 | RU-29a, RU-29b, RE-02 | SPI-445 |
| RS-30 | RU-30a, RU-30b | SPI-445 |
| RS-31 | RU-31 | SPI-445 |
| RS-32 | RU-32 | SPI-445 |
| RS-33 | RE-01 | SPI-445 |
| RS-34 | RU-34, existing outbound specs unmodified | SPI-445 |
| RS-35 | RU-35 | SPI-445 |
| RS-36 | RU-36a, RU-36b | SPI-445 |
| RS-37 | RU-37, RE-02 | SPI-445 (gRPC status mapping by SPI-431) |
| RS-38 | RU-38a, RU-38b | SPI-445 |
| RS-39 | RU-39 | SPI-445 (consumed by SPI-430, SPI-436) |
| RS-40 | RU-40a, RU-40b | SPI-445 |
| RS-41 | RU-41 | SPI-445 |
| RS-42 | RU-42 | SPI-445 (exposure: SPI-432) |
| RS-43 | RU-43a, RU-43b, RU-43c | SPI-445 (masker: SPI-433, soft) |
| RS-44 | RU-44 | SPI-445 |
| RS-45 | RU-45 | SPI-445 |
| RS-46 | RU-46 | SPI-445 |
| RS-47 | RU-47 | SPI-445 |
| RS-48 | RU-48 | SPI-445 (consumed by KA spec) |
| RS-49 | RU-49 | SPI-445 (consumed by KA spec) |
| RS-50 | RU-50 | SPI-445, after SPI-429 (else follow-up) |
| RS-51 | RU-51 | SPI-445 |
| RS-52 | RU-52 | SPI-445 |
| RS-53 | RU-53a, RU-53b | SPI-445 |
| RS-54 | RU-54 | SPI-445 |
| RS-55 | RU-55 | SPI-445 |
| RS-56 | RU-56 | SPI-445 |
| RS-57 | RU-57 | SPI-445 (option types shared with SPI-429, SPI-433) |
| RS-58 | RU-58 | SPI-445 (tap redaction: SPI-433) |
| RS-59 | RU-59 | SPI-445 |
| RS-60 | RU-60a, RU-60b | SPI-445 (step key resolver: SPI-429, soft) |
| RS-61 | RU-61 | SPI-445 |
| RS-62 | RU-62a, RU-62b, RU-62c | SPI-445 |
| RS-63 | RU-63 | SPI-445 |
| RS-64 | RU-64a, RU-64b, RE-08 | SPI-445 (step claim: SPI-429) |
| RS-65 | RU-65 | SPI-445 |
| RS-66 | RU-66a, RU-66b | SPI-445 (exposure: SPI-432) |
| RS-67 | RU-67, RE-09 | SPI-445 (resolver shared with SPI-429, SPI-433) |
| RS-68 | RU-68 | SPI-445 |
| RS-69 | RU-69 | SPI-445 |
| RS-70 | RU-70, existing flow specs unmodified | SPI-445 |
| RS-71 | RU-71 | SPI-445 (gRPC engine: SPI-430) |

## 18. Estela-own vocabulary (amended 2026-11-10, D34)

Every public name of this feature (exports, option keys, error classes, events, metrics, headers, graph text, finding codes and testing helpers) uses the Estela vocabulary below. The textbook words of the earlier drafts appear only in the "0.9.0 spellings" migration rows (section 1) and in the left column of these tables. Requirement IDs (`RS-`, `RU-`, `RE-`), file paths under `src/resilience/` and the name of this file do not change. Prose may still use the general engineering words to explain a mechanism; every name a user writes or reads follows this section.

Composition order (RS-02):

```text
planB > patience.total > lanes > tries > valve > pace > patience.eachTry > call
```

### 18.1 Module, references and context

| Earlier draft | Final |
|---|---|
| `forRoot({ resilience })`, `ResilienceModuleOptions` | `forRoot({ care })`, `CareModuleOptions` |
| `.policies`, `.retryBudget { header, initial }`, `.stateTimeoutMs`, `.stateProbeMs` | `.profiles`, `.triesLeft { header, initial }`, `.sharedStateWaitMs`, `.sharedStateCheckMs` |
| `ResiliencePolicy`, `NamedResiliencePolicy`, `ResiliencePolicyRef<P>`, `ResilienceRef` | `Care`, `CareProfile`, `CareRefOf<C>`, `CareRef` |
| `InboundResiliencePolicy`, `InboundResilienceRef`, `InboundShedContext` | `InboundCare`, `InboundCareRef`, `InboundCareContext` |
| `OutboundRestResilience`, `ResilienceEdgeKind` | `OutboundRestCare`, `CareEdge` |
| `ResilienceContext` (`attempt`) | `CareContext` (`tryNumber`) |
| `ResilienceClassifierFn`, `ResilienceKeyFn` | `CareClassifierFn`, `CareKeyFn` |
| class `'throttled'`, `Classification.retryAfterMs` | `'busy'`, `Classification.readyInMs` |
| `RejectionKind` (`'circuit-open' \| 'bulkhead-full' \| 'rate-limited' \| 'deadline'`) | `TurnedAwayKind` (`'valve-shut' \| 'lanes-full' \| 'over-pace' \| 'out-of-time'`) |
| `FallbackTrigger` | `PlanBTrigger` |
| `ResilienceClock`, `ResilienceTimer`, `ResilienceLogger`, `ResilienceMetricsPort` | `CareClock`, `CareTimer`, `CareLogger`, `CareMetricsPort` |
| `ResilienceEvent`, `ResilienceEventType`, `DEFAULT_RESILIENCE_EVENTS_CHANNEL = 'estela.resilience.events'` | `CareEvent`, `CareEventType`, `DEFAULT_CARE_EVENTS_CHANNEL = 'estela.care.events'` |
| Nest `Logger('EstelaResilience')` | `Logger('EstelaCare')` |

### 18.2 Parts and fields

| Earlier draft | Final |
|---|---|
| `timeout` / `TimeoutPolicy` (`perAttemptMs`, `deadlineMs`) | `patience` / `Patience` (`eachTryMs`, `totalMs`) |
| `retry` / `RetryPolicyOptions` (`maxAttempts`, `backoff`, `retryOn`, `honorRetryAfter`, `maxRetryAfterMs`, `propagate: 'claim' \| 'forward'`) | `tries` / `Tries` (`max`, `spacing`, `on`, `heedServerWait`, `maxServerWaitMs`, `triesLeft: 'keep' \| 'forward'`) |
| `BackoffPolicy` (`initialMs`, `factor`, `maxMs`, `jitter: 'full' \| 'equal' \| 'none'`), `BackoffFn` | `Spacing` (`firstMs`, `growth`, `capMs`, `spread: 'full' \| 'half' \| 'none'`), `SpacingFn` |
| `circuitBreaker` / `CircuitBreakerPolicy` (`failureRateThreshold`, `minimumCalls`, `window`, `openMs`, `halfOpenCalls`, `recordOn`, `quotaOpenMs: number \| 'manual'`) | `valve` / `Valve` (`failPercent`, `minCalls`, `lookBack: { lastCalls } \| { lastMs }`, `shutMs`, `probes`, `countOn`, `onQuota: OnQuota`, `quotaShutMs: number`) |
| breaker states `'closed' \| 'open' \| 'half-open'` | valve states `'flowing' \| 'shut' \| 'probing'` |
| `bulkhead` / `BulkheadPolicy` (`maxConcurrent`, `maxQueue`, `queueTimeoutMs`) | `lanes` / `Lanes` (`count`, `waitlist`, `waitlistMs`) |
| `rateLimit` / `RateLimitPolicy` (`limitPerSec`, `maxWaitMs`, `degradedLimitPerSec`, `replicasHint`) | `pace` / `Pace` (`perSecond`, `waitMs`, `soloPerSecond`, `replicas`) |
| `fallback` / `FallbackPolicy` | `planB` / `PlanB` |

Unchanged: `enabled`, `idempotent`, `requireIdempotencyKey`, `methods`, `key`, `maxKeys`, `state`, `syncMs`, `burst`, `value`, `channel`, `on` (plan B), `cacheable`, `classify`, `use`, `extends`, `ProfileName`.

### 18.3 Option key on every endpoint

`ChannelSpec.resilience`, `FlowOptions.resilience { handle, jump, send }`, the step option `resilience`, `FlowTarget.resilience`, `ActivatorOptions.resilience`, `InboundSpec.resilience`, `InboundDefaults.resilience`, `OutboundRestOptions.resilience`, saga `OutboundOptions.resilience`, `SagaRunnerOptions.resilience`, the flow executor dependency `resilience` and the testing option `bindFlow(..., { resilience })` are all named `care`.

### 18.4 Errors

| Earlier draft | Final | `kind` |
|---|---|---|
| `ResilienceError` (brand `@estela/nest.ResilienceError`), `ResilienceErrorKind`, `ResilienceErrorMeta` (`attempts`) | `CareError` (brand `@estela/nest.CareError`), `CareErrorKind`, `CareErrorMeta` (`tries`) | base |
| `resilienceMessage`, `rejectionTrigger` | `careMessage` (text `after N try(ies)`), `turnedAwayTrigger` | n/a |
| `CircuitOpenError` (`retryAfterMs`) | `ValveShutError` (`readyInMs`, `forcedBy: 'quota'`) | `'valve-shut'` |
| `BulkheadFullError` (`reason: 'full' \| 'queue-timeout'`) | `LanesFullError` (`reason: 'full' \| 'waitlist-expired'`) | `'lanes-full'` |
| `RateLimitedError` (`retryAfterMs`) | `OverPaceError` (`readyInMs`) | `'over-pace'` |
| `DeadlineExceededError` (`deadlineMs`) | `OutOfTimeError` (`totalMs`) | `'out-of-time'` |
| `FallbackFailedError` | `PlanBFailedError` | `'plan-b-failed'` |
| `ResilienceKeyError`, `ResilienceKeyErrorReason` | `CareKeyError`, `CareKeyErrorReason` | `'key'` |
| `ResilienceDefinitionError` | `CareConfigError` (message `<binding>: care.<path> <rule>`) | `'config'` |
| `AttemptTimeoutError` | `TryOverdueError` (REST keeps `OutboundTimeoutError`) | n/a |
| `InboundOverloadedError` (code `INBOUND_OVERLOADED`, `reason: 'bulkhead-full' \| 'rate-limited'`, `retryAfterMs`) | `InboundBusyError` (code `INBOUND_BUSY`, `reason: 'lanes-full' \| 'over-pace'`, `readyInMs`) | n/a |

### 18.5 Engine, control, scope, headers and shared state

| Earlier draft | Final |
|---|---|
| `ResilienceExecutor`, `ExecuteOptions`, `ResilienceAttempt` (`attempt`, `timeoutMs`, `budgetOut`), `ResilienceResult` (`attempts`, `fallback`) | `CareExecutor`, `CareExecuteOptions`, `CareTry` (`tryNumber`, `eachTryMs`, `triesLeftOut`), `CareResult` (`tries`, `planB`) |
| `ResilienceEdgeAdapter` (`timeoutError`, `outgoingBudget`, `isTimeout`), `ResilienceDeps` | `CareEdgeAdapter` (`overdueError`, `outgoingTriesLeft`, `isOverdue`), `CareDeps` |
| `ResiliencePlan`, `resolveResiliencePlan`, `describePolicy` | `CarePlan`, `resolveCarePlan`, `describeCare` |
| `ResilienceRegistry` (`breakerState`, `resetBreaker`), `BreakerStateView` | `CareControl` (`valveState`, `resume`), `ValveStateView` |
| `ResilienceRuntime`, DI token `RESILIENCE_RUNTIME = 'INTEGRATION_RESILIENCE_RUNTIME'` | `CareEngine`, `CARE_ENGINE = 'INTEGRATION_CARE_ENGINE'` |
| `ResilienceScope` (`markDegraded`), `ResilienceScopeValue` (`budget`, `degraded`), `currentResilienceSignal()` | `CareScope` (`markPlanB`), `CareScopeValue` (`triesLeft`, `planB`), `currentTrySignal()` |
| `parseRetryAfter`, `parseRetryBudget` | `parseServerWait`, `parseTriesLeft` |
| `RETRY_BUDGET_HEADER = 'x-retry-budget'`, `RETRY_BUDGET_MESSAGE_HEADER = 'retryBudget'` | `TRIES_LEFT_HEADER = 'x-tries-left'`, `TRIES_LEFT_MESSAGE_HEADER = 'triesLeft'` |
| `DEGRADED_HEADER = 'degraded'`, `headers.jumpDegraded[ch]` | `PLAN_B_HEADER = 'planB'`, `headers.jumpPlanB[ch]` |
| `ResilienceStatePort` (`takeToken` -> `{ granted, retryAfterMs }`, `markOpen`, `openUntil`, `tryProbeLease`, `clearOpen`) | `CareStatePort` (`takeTurn` -> `{ granted, readyInMs }`, `markShut`, `shutUntil`, `claimProbe`, `clearShut`) |
| `redisResilienceStatePort`, key prefix `estela:rs:<kind>:<binding>` | `redisCareState`, key prefix `estela:care:<part>:<binding>` (`<part>` is `valve` or `pace`) |
| testing `manualResilienceClock`, `ManualResilienceClock`, `MemoryResilienceStatePort`, `collectResilienceEvents` | `manualCareClock`, `ManualCareClock`, `MemoryCareState`, `collectCareEvents` |

### 18.6 Events, metrics, graph and finding codes

| Earlier draft | Final |
|---|---|
| events `retry`, `retry.suppressed` | `try.again`, `try.held` |
| `breaker.open`, `breaker.half-open`, `breaker.closed`, `breaker.forced-open`, `breaker.capacity` | `valve.shut`, `valve.probing`, `valve.flowing`, `valve.forced-shut`, `valve.keys-full` |
| `bulkhead.rejected`, `ratelimit.rejected`, `deadline.exceeded` | `lanes.full`, `pace.over`, `patience.ran-out` |
| `fallback.used`, `fallback.failed`, `quota.exhausted`, `state.degraded`, `state.recovered` | `plan-b.used`, `plan-b.failed`, `quota.used-up`, `shared-state.lost`, `shared-state.back` |
| event field `attempt` | `tryNumber` |
| `estela_resilience_calls_total` (outcome `success\|failure\|fallback\|rejected`), `_call_seconds` | `estela_care_calls_total` (outcome `success\|failure\|plan-b\|turned-away`), `estela_care_call_seconds` |
| `estela_resilience_attempts_total`, `_retries_total`, `_rejected_total` | `estela_care_tries_total`, `estela_care_extra_tries_total`, `estela_care_turned_away_total` |
| `estela_resilience_breakers_open`, `_state_degraded`, `_budget_invalid_total` | `estela_care_valves_shut`, `estela_care_shared_state_lost`, `estela_care_tries_left_invalid_total` |
| graph `policy`, `GraphSnapshot.module.policies`, `retryGate` / `retryGateOf` | graph `care`, `GraphSnapshot.module.careProfiles`, `repeatableBy` / `repeatableByOf` |
| summary words `timeout`, `deadline`, `retry xN`, `breaker`, `bulkhead`, `ratelimit`, `fallback` | `patience`, `total`, `tries xN`, `valve`, `lanes`, `pace`, `plan-b` |
| `FlowParameterFinding.concern: 'resilience'`, paths `resilience.<path>` | `'care'`, `care.<path>` |
| `WIRETAP_RESILIENCE`, `PRIMITIVE_NOT_ALLOWED`, `PRIMITIVE_DROPPED`, `FALLBACK_CHANNEL_MISSING`, `FALLBACK_CACHEABLE` | `WIRETAP_CARE`, `CARE_PART_NOT_ALLOWED`, `CARE_PART_DROPPED`, `PLAN_B_CHANNEL_MISSING`, `PLAN_B_CACHEABLE` |
| `RETRY_WITHOUT_KEY_GATE`, `RETRY_STACKED`, `RETRY_DECLARED_IDEMPOTENT` | `TRIES_WITHOUT_KEY`, `TRIES_STACKED`, `TRIES_DECLARED_IDEMPOTENT` |

Unchanged: `UNKNOWN_PROFILE`, `PROFILE_CYCLE`, `PROFILE_DEPTH`, `PROFILE_NAME`, `DUPLICATE_STEP_ID`, `LEGACY_AND_NEW_SAME_LAYER`, `INVALID_OPTION`, the default classifiers, `RedisEvalFn`, and the 0.9.0 names `retry`, `timeoutMs`, `retry: false`, `OutboundTimeoutError`, `DEFAULT_OUTBOUND_MAX_ATTEMPTS`, `DEFAULT_OUTBOUND_TIMEOUT_MS`, `MAX_RETRY_ATTEMPTS`, `MAX_BACKOFF_MS`, `JitterMode`, the saga `retry()` and `RetryPolicy`. Protocol names (`Retry-After`, status 429, `RESOURCE_EXHAUSTED`, `grpc-retry-pushback-ms`) are only read or emitted; no public field is named after them.

**Coexistence with the 0.9.0 spellings.** `timeoutMs: N` is the 0.9.0 spelling of `care.patience.eachTryMs: N`, and `retry: {...}` the 0.9.0 spelling of `care.tries`: it keeps 0.9.0 behaviour (no spread, no server wait, field-by-field layering, no `x-tries-left` read or sent). The same part in both spellings on one layer fails with `LEGACY_AND_NEW_SAME_LAYER` (`CareConfigError`); different parts or layers are allowed and log no deprecation warning.
