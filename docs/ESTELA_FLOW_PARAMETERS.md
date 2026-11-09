# ESTELA flow parameter model (shared by SPI-433, SPI-429, SPI-445 and the KA- adoption spec)

Status: proposal. It is checked against the code at `estela-wt-SPI-428` (0.9.0). It does not replace any rule in the three library specs. It names the levels, the merge rule for each concern, the profile references, and the option shapes a flow author writes. Each spec should link this model instead of restating these rules.

The normative requirements live in the library specs: `ESTELA_SENSITIVE_DATA_SPEC.md` section 18 (SPI-433, which also ships the shared scaffolding, SD-67), `ESTELA_RESILIENCE_SPEC.md` section 2.13 (SPI-445) and `ESTELA_MULTI_REPLICA_SPEC.md` section 16 (SPI-429). When this document and a spec disagree, the spec wins and this document is corrected. This file is the proposed answer to the location question (SD Q12, RS OQ-16, MR OQ-14).

## 0. What exists today (ground truth)

| Surface | Signature today | File:line |
|---|---|---|
| Flow builder | `IntegrationFlow.from(source)` | `src/flow/integration-flow.ts:41` |
| `filter` / `transform` / `handle` | `(fn)` with no options | `integration-flow.ts:45,50,55` |
| `wireTap` | `(channel)`; uses `copyMessage`, fire-and-forget, never fails the flow | `integration-flow.ts:60`, `steps/wire-tap.step.ts:14-17` |
| `fanoutTo` / `jumpTo` | `(dests: FanoutDest[])`, where `FanoutTargetInput = { channel, wait?, timeoutMs? }` | `integration-flow.ts:65,70`, `flow-step.ts:43-49` |
| `jump` | `(channel, { wait?, timeoutMs? })`; default 10 000 ms; uses a fresh `reply.<uuid>` per hop, unregistered in `finally` | `integration-flow.ts:75`, `steps/jump.step.ts:13,56-77` |
| `publish` / `route` / `to` / `reply` | `(channel, routingKey?)`, `(fn)`, `(channel)`, `(ReplyOptions)` | `integration-flow.ts:83,88,93,98` |
| Flow definition | `FlowDefinition { name; build() }` | `integration-flow.ts:20-23` |
| Flow idempotency | scope `flow:<name>`, key from `headers.idempotencyKey`, `begin/complete/fail` | `flow/flow-executor.ts:58-85` |
| Error envelopes | flow `reportError`, fire-and-forget, registry `onError` | `flow-executor.ts:139-150`, `steps/forget.ts:9-25`, `integration.module.ts:161-171` |
| Channels | `ChannelSpec { name, type, capacity?, bindings? }`; kinds direct, queue, pubsub, fanout | `channel-factory.ts:9-14`, `channel.ts:10` |
| Module | `forRoot(options, flows)`; boot order: channels, activators, outbounds, flows, explorer | `integration.module.ts:132`, `:245-286` |
| Activator | `@ServiceActivator(channel, { group?, routingKey? })` | `decorators.ts:8-11,33` |
| Inbound | `@InboundRest(spec)` / `@InboundGrpc(spec)`; `InboundSpec { channel, requestReply?, timeoutMs?, reply?, idempotency? }` | `inbound/inbound.decorators.ts:25,32`, `inbound/inbound.types.ts:11-27` |
| Outbound REST | `request(target, message, call)`; layers are call, binding and `outbound.rest.defaults` | `outbound/outbound-rest.gateway.ts:90-97`, `outbound/outbound.types.ts:285-372` |
| gRPC out | `bindGrpcOut(registry, fromChannel, stub, { replyChannel? })` | `adapters/grpc.adapter.ts:12-31` |
| Saga outbound | `.outbound(name, run, { compensate?, compensateLocks? })` | `saga/saga.ts:66-72,124` |
| Graph | `GET /integration/graph`; `recordFlow` stores each step's `describe()` | `graph/channel-graph.controller.ts:15`, `graph/channel-graph.ts:125-128` |

None of the flow DSL methods accepts a resilience, sensitive or idempotency option today. This model adds them. Every addition is an optional trailing parameter.

## 1. Levels and precedence

### 1.1 Levels (highest wins)

| # | Level | Where it is written |
|---|---|---|
| L5 | **call** | `OutboundRestCallOptions` / ad-hoc `request()` options; SDK and gRPC call options (SPI-430/436). A flow step has no call level. |
| L4 | **step / endpoint** | a DSL step option; one fanout or jump target; `@ServiceActivator`; `@InboundRest`/`@InboundGrpc` spec; `OutboundRestBinding`/`@OutboundRest`; a saga `.outbound` step. |
| L3 | **flow** | `IntegrationFlow.from(source, options)` (new, section 3.2) |
| L2 | **channel** | `ChannelSpec` in `forRoot({ channels })` |
| L1 | **module** | `forRoot({ resilience, sensitive, idempotency, replicas, outbound.rest.defaults, inbound })` |
| L0 | **built-in** | the defaults in each spec (for example RS-01 "no primitive, one attempt"; SD baseline `secrets@1`; MR `'fail-closed'`, `'single'`) |

**Which channel is L2:**
- For a send step (`to`, `publish`, `route`, `fanoutTo`, `jumpTo`), it is the **destination** channel.
- For `handle`, `filter`, `transform` and the flow claim, it is the flow's **source** channel.
- For an activator or inbound endpoint, it is its own channel.

**Runtime caps are not levels.** The remaining deadline, the incoming `x-retry-budget` (RS-29..31), and a `sideEffects` channel's fail-closed rule (MR) only narrow a resolved value. They never widen it.

### 1.2 Merge semantics per concern

| Concern | Across levels | Inside one reference (`use` plus inline) | `false` |
|---|---|---|---|
| **Resilience** | **Per-primitive replace.** The highest level that sets `timeout`, `retry`, `circuitBreaker`, `bulkhead`, `rateLimit`, `fallback` or `classify` owns that key whole. Other primitives keep inheriting. There is no field-level merge across levels, which matches today's "not inherited when a binding passes an object" (`outbound.types.ts:250,268`). | **Deep merge, one time only.** Inline fields merge into the named profile's primitive field by field. Arrays and functions replace. `false` replaces. | `resilience: false` means no policy at this level and below: one direct attempt. `retry: false` disables only that primitive. |
| **Sensitive** | **Union, stricter wins** (SD-17, unchanged). `fields`, `headers`, `patterns` and `packs` are unioned. Per path, the stricter mode wins. `allow` is the only way to weaken, and it applies to its own level and the levels inside it. `storeMode` comes from the most specific level that sets it. | Same union rule. A list `use: ['pii','secrets']` unions the profiles in order. | Only valid at L1 (`forRoot({ sensitive: false })`, the existing switch). At L2..L5 it is a boot error (`SENSITIVE_FALSE_BELOW_MODULE`). Use `allow` with a `reason` instead. |
| **Idempotency / store** | **Per-key replace** (`ttlMs`, `store`, `onStoreUnavailable`, `scope`, `key`). | Not applicable. Stores are referenced by name only. | `idempotency: false` turns off this level's claim only. It never turns off an outer claim, such as the flow claim under a step claim. |
| **Replicas** | **Module only.** `replicas` exists only at L1, or through `ESTELA_REPLICAS` (MR-22). | Not applicable. | Not applicable. |

**Floors that no lower level can lift:**
- `ChannelSpec.sideEffects: true` keeps the scope fail-closed.
- `delivery: 'must-not-lose'` is refused for in-memory kinds when `replicas: 'multi'`.
- The sensitive baseline stays on unless the module sets `false`.
- `storeMode: 'plain'` needs `storeModeReason`.

## 2. Named reusable profiles (L1)

```ts
// Profile names: ^[a-z0-9][a-z0-9._-]{0,63}$ (the grammar of PatternRule.name).
export type ProfileName = string;

export interface NamedResiliencePolicy extends ResiliencePolicy {
  /** Single inheritance, resolved at boot; cycles and depth > 8 fail boot. */
  extends?: ProfileName;
}
export interface NamedSensitivePolicy extends SensitivePolicy {
  extends?: ProfileName | readonly ProfileName[];
}

// forRoot additions (all optional, additive)
export interface ResilienceModuleOptions /* SPI-445 3.1 */ {
  policies?: Readonly<Record<ProfileName, NamedResiliencePolicy>>;
  /** L1 defaults per edge kind; a value is a profile name or an inline policy. */
  defaults?: Partial<Record<ResilienceEdgeKind, ResilienceRef>>;
}
export interface SensitiveModuleOptions /* SPI-433 4.1 */ {
  profiles?: Readonly<Record<ProfileName, NamedSensitivePolicy>>;
}
export interface IntegrationIdempotencyOptions /* SPI-429 3.13 */ {
  /** Named stores; `store` (the module store) may then be a name. */
  stores?: Readonly<Record<ProfileName, IdempotencyStore | InboundProviderRef<IdempotencyStore>>>;
  store?: IdempotencyStore | ProfileName;
}

// References accepted at L2..L5
export type ResilienceRef =
  | ProfileName
  | (ResiliencePolicy & { use?: ProfileName })
  | false;
export type InboundResilienceRef =
  | ProfileName                      // profile must hold only bulkhead/rateLimit (RS-37)
  | (InboundResiliencePolicy & { use?: ProfileName })
  | false;
export type SensitiveRef =
  | ProfileName
  | readonly ProfileName[]
  | (SensitivePolicy & {
      use?: ProfileName | readonly ProfileName[];
      /** 'sinks' (default) | 'mask-payload' (L4 only, section 4.4). */
      apply?: 'sinks' | 'mask-payload';
      applyReason?: string;          // required with 'mask-payload', logged at boot
    });
export type StoreRef = ProfileName | IdempotencyStore | InboundProviderRef<IdempotencyStore>;
```

New edge kinds extend `ResilienceEdgeKind` (SPI-445 3.1): `'flow-handle' | 'flow-jump' | 'flow-send'`. The defaults map uses them as keys.

Example:

```ts
IntegrationModule.forRoot({
  resilience: {
    policies: {
      'http-std': { timeout: { perAttemptMs: 2000, deadlineMs: 8000 }, retry: { maxAttempts: 3 } },
      'http-guarded': { extends: 'http-std', circuitBreaker: { openMs: 30000 } },
      'jump-sla': { timeout: { perAttemptMs: 3000 }, retry: { maxAttempts: 2 },
                    fallback: { value: () => ({ status: 'unknown' }) } },
    },
    defaults: { 'outbound-rest': 'http-std', 'flow-jump': 'jump-sla' },
  },
  sensitive: {
    packs: ['secrets@1'],
    profiles: {
      pii: { packs: ['pii@1'] },
      card: { fields: [{ path: '**.pan', mode: 'partial', keepLast: 4 }] },
    },
  },
  idempotency: { stores: { shared: redisStore, ledger: pgStore }, store: 'shared', ttlMs: 3_600_000 },
  replicas: 'multi',
  channels: [
    { name: 'payments.charge', type: 'direct', sideEffects: true,
      sensitive: 'card', resilience: 'http-guarded', idempotency: { store: 'ledger' } },
  ],
});
```

## 3. Option shapes

### 3.1 Common step option and per-method table

```ts
export interface StepCommonOptions {
  /** Stable step id: graph label, policy subject `flow:<flow>#<id>`, step idempotency scope.
   *  Default `<kind>#<index>`. Unique per flow (boot error DUPLICATE_STEP_ID). */
  id?: string;
  /** Redaction of this step's sink copies (hop log, error envelope, events). */
  sensitive?: SensitiveRef;
}

export interface StepIdempotencyOptions {
  /** Default: headers.idempotencyKey. A resolver returning undefined means no key for this run. */
  key?: (payload: unknown, msg: IntegrationMessage) => string | undefined;
  scope?: string;                    // default `flow:<flow>#<stepId>`
  ttlMs?: number;
  store?: StoreRef;
  onStoreUnavailable?: StoreUnavailablePolicy;
}

/** A target of fanoutTo / jumpTo (extends today's FanoutTargetInput). */
export interface FlowTarget extends FanoutTargetInput {
  resilience?: ResilienceRef;
  sensitive?: SensitiveRef;
}
export type FlowDest = string | FlowTarget;
```

| DSL method (new signature) | `resilience` | `sensitive` | `idempotency` | Notes |
|---|---|---|---|---|
| `filter(predicate, opts?: StepCommonOptions)` | no | yes | no | A pure function: retrying it adds nothing. |
| `transform(fn, opts?: StepCommonOptions)` | no | yes, and `apply: 'mask-payload'` | no | Use `handle` for side effects. |
| `handle(fn, opts?: StepCommonOptions & { resilience?: ResilienceRef; idempotency?: false \| StepIdempotencyOptions })` | yes, all primitives (`flow-handle`, `defaultInProcessClassifier`) | yes, and mask-payload on its output | yes | Retry happens between the step `claim` and `complete`, so it never claims twice (same shape as RS-36). |
| `wireTap(channel, opts?: StepCommonOptions & { redact?: boolean; redactReason?: string })` | **never** | yes; the tap copy is always redacted | no | See rule 4.1. `redact: false` needs `redactReason`. |
| `fanoutTo(dests: FlowDest[], opts?: StepCommonOptions & { resilience?: ResilienceRef })` | yes, per target (`flow-send`); no `fallback` | yes, per target | inherited from the message key | `wait: false` targets: resilience still applies, but failures still go to error.channel (`forget.ts:15-24`). |
| `jumpTo(dests: FlowDest[], opts?: …same)` and `jump(channel, { wait?, timeoutMs?, resilience?, sensitive?, id? })` | yes, all primitives (`flow-jump`); `fallback` only on awaited targets | yes | inherited | See rule 4.5. |
| `publish(channel, routingKey?, opts?)` and `publish(channel, opts)` | yes (`flow-send`); no `fallback` | yes, and mask-payload on the hop copy | inherited | Overload: a string second argument is the routing key. |
| `route(fn, opts?: StepCommonOptions & { resilience?: ResilienceRef })` | yes, per resolved target; no `fallback` | yes | inherited | The policy is resolved per target channel at run time. Profile names are still validated at boot. |
| `to(channel, opts?: StepCommonOptions & { resilience?: ResilienceRef })` | yes (`flow-send`); `fallback` only as `{ channel }` | yes, and mask-payload | inherited | Terminates the flow, as today (`to.step.ts:23`). |
| `reply(options?: ReplyOptions & { id?: string })` | no | no | no | The reply payload goes to the caller, so it is never redacted (rule 4.4). |

`ReplyOptions` keeps `payload` (`reply.step.ts:3-6`).

On `jump` and `jumpTo`, a target's `timeoutMs` is the **legacy alias** of `resilience.timeout.perAttemptMs`. Setting both on the same target is refused (`LEGACY_AND_NEW_SAME_LAYER`, the RS-35 rule).

### 3.2 Flow-level defaults (L3)

```ts
export interface FlowOptions {
  /** Per step family: one flow default cannot leak a primitive into a step that refuses it. */
  resilience?: { handle?: ResilienceRef; jump?: ResilienceRef; send?: ResilienceRef };
  sensitive?: SensitiveRef;                      // apply: 'mask-payload' refused here
  idempotency?: false | { ttlMs?: number; store?: StoreRef; onStoreUnavailable?: StoreUnavailablePolicy; scope?: string };
}
// integration-flow.ts
static from(source: string, options?: FlowOptions): IntegrationFlow;
// FlowDefinition gains nothing: options travel inside the built flow (BuiltFlow.options?).
```

- `send` covers `to`, `publish`, `route` and `fanoutTo`.
- `idempotency` configures the existing `flow:<name>` claim (`flow-executor.ts:59-66`). Today that claim only uses the module TTL and store.
- A flow default never applies to `wireTap`, `filter`, `transform` or `reply`.

### 3.3 Channel level (L2)

```ts
export interface ChannelSpec {
  name: string; type: ChannelKind; capacity?: number; bindings?: readonly string[];
  delivery?: 'best-effort' | 'must-not-lose';     // SPI-429
  sideEffects?: boolean;                          // SPI-429 (floor: fail-closed)
  sensitive?: SensitiveRef;                       // SPI-433 (was SensitivePolicy; widened to refs)
  /** Default for flow steps that send INTO this channel and for activators ON it. */
  resilience?: ResilienceRef;
  idempotency?: { store?: StoreRef; ttlMs?: number; onStoreUnavailable?: StoreUnavailablePolicy };
}
```

Channel `resilience` is never applied to inbound endpoints. Inbound endpoints accept only load shedding (RS-37), and that comes from `InboundDefaults` or `InboundSpec`.

### 3.4 Decorators and adapters (L4)

```ts
// decorators.ts
export interface ActivatorOptions {
  group?: string; routingKey?: string;
  resilience?: ResilienceRef;            // RS-36 semantics
  sensitive?: SensitiveRef;              // SD scope activator:<Class>.<method>
  idempotency?: { store?: StoreRef; ttlMs?: number; onStoreUnavailable?: StoreUnavailablePolicy };
}
// inbound/inbound.types.ts (InboundRest / InboundGrpc / InboundGraphQL)
export interface InboundSpec { /* existing */ resilience?: InboundResilienceRef; sensitive?: SensitiveRef }
export interface InboundIdempotencyOptions { /* existing */ store?: StoreRef /* name allowed */; storeMode?: StoreMode; onStoreUnavailable?: StoreUnavailablePolicy }
export interface InboundDefaults { /* existing */ resilience?: InboundResilienceRef; sensitive?: SensitiveRef }
// outbound/outbound.types.ts
export interface OutboundRestOptions { /* existing */ resilience?: ResilienceRef; sensitive?: SensitiveRef }
export interface OutboundRestCallOptions { /* existing */ resilience?: ResilienceRef /* RS-33 limits */; sensitive?: SensitiveRef }
// adapters/grpc.adapter.ts (the engine is wired by SPI-430; the shape is fixed here)
bindGrpcOut(registry, fromChannel, stub, options?: { replyChannel?: string; id?: string; resilience?: ResilienceRef; sensitive?: SensitiveRef })
// saga/saga.ts
export interface OutboundOptions<Ctx, Tx> { /* existing */ resilience?: ResilienceRef }   // profile with fallback => SagaDefinitionError
SagaRunnerOptions.sensitive.policy?: SensitiveRef   // names resolve only when `runtime` is passed
```

`@InboundRabbit` with any `resilience` is a boot error (RS-37).

## 4. Semantic rules

**4.1 wireTap never carries resilience.**
- The type has no field for it.
- A JS caller passing `resilience` gets `FlowDefinitionError(WIRETAP_RESILIENCE)` when the flow is built.
- Flow and channel resilience defaults skip wireTap, including a channel default on the tap's destination channel.
- The tap stays fire-and-forget and swallows failures (`wire-tap.step.ts:16`).
- The tap copy does not consume or forward the retry budget: the `retryBudget` header is removed from the copy.

**4.2 A step retries only under an idempotency key.** An attempt after the first runs only when one of these holds:
- (a) the message carries `headers.idempotencyKey` (propagated by `nextHop`, `message.ts:155`);
- (b) the step's `idempotency.key` resolves a non-empty key;
- (c) the step's policy declares `retry.idempotent: true`. This is the RS-09/RS-36 escape hatch. It is logged at boot and shown in the graph as `retryGate: 'declared'`.

Otherwise `maxAttempts` is reduced to 1 at run time and `retry.suppressed` is emitted. A step policy with `retry.requireIdempotencyKey: true` fails before the first attempt instead (RS-48).

Boot warning `RETRY_WITHOUT_KEY_GATE`: `maxAttempts > 1` on a step whose flow has no idempotency and no `idempotent: true`.

Boot warning `RETRY_STACKED`: a send-step retry toward a channel whose bound activator or outbound binding also retries. The retry budget (RS-29..31) bounds the amplification at run time.

**4.3 A fallback result is never stored as an idempotent result** (RS-27). When any `fallback` fires during a run, `ResilienceScope.markDegraded()` marks the scope. On a degraded run:
- the step claim and the flow claim settle with `fail` (or `release` when the store has it), not `complete`, so a redelivery with the same key runs again;
- an activator never writes `cachedResult` (`activator-wrapper.ts:99-104`);
- inbound `onDuplicate: 'replay'` never replays it.

`fallback.cacheable: true` is the only opt-out. It is logged at boot.

The fallback value:
- on `jump`, lands in `headers.jumpReplies[channel]` with `headers.jumpDegraded[channel] = true`;
- on `handle`, becomes the payload.

**4.4 Redaction targets sinks, not deliveries.** The effective policy (L1..L4, union) is applied to copies written to:
- hop logs (`hop-logger.ts`);
- error.channel envelopes (`flow-executor.ts:139-150`, `forget.ts:16-24`, `integration.module.ts:161-171`, and the error.channel logger at `:253-255`);
- wireTap copies;
- resilience events;
- graph describe output.

It **never** changes the payload or headers delivered to handlers, next steps, `to`/`publish`/`route`/`fanoutTo`/`jumpTo` destinations, outbound calls or `reply`. Copy-on-write sharing (SD 6.2 step 4) guarantees this.

The single exception is `sensitive: { apply: 'mask-payload', applyReason }` on an L4 step, which masks:
- the output of `transform` or `handle`;
- or the hop copy sent by `publish`, `to`, `fanoutTo` or `jumpTo`.

`mask-payload` at L1, L2 or L3, or on `filter`, `wireTap` or `reply`, is a boot error (`MASK_PAYLOAD_LEVEL`). A tap copy is redacted with the policy of (module, tap channel, flow, step). `redact: false` needs `redactReason`.

**4.5 A jumpTo policy wraps send plus await reply.** For each awaited target, one attempt is:
1. open a new `reply.<uuid>` channel;
2. send the hop;
3. await the first reply under `perAttemptMs`, which defaults to target `timeoutMs`, else 10 000 (`jump.step.ts:13,36`);
4. in `finally`, cancel the wait and unregister the channel (`:73-77`).

The other steps of the call:
- `deadlineMs` covers every attempt and backoff.
- A late reply to an earlier attempt reaches an unregistered channel and is dropped.
- `JumpTimeoutError` (`flow-step.ts:55`) is classified `transient` by the `flow-jump` adapter.
- Targets with `wait: false` run the same attempt loop in the background. They refuse `fallback`, and their final failure goes to error.channel as today (`jump.step.ts:38`).
- Sibling targets of one `jumpTo` resolve their policies independently, and `Promise.all` still joins them (`:43`).

**4.6 Allowed primitives per edge.** This is the RS-05/5.5 table extended:
- `flow-handle`: all primitives.
- `flow-jump`: all primitives; fallback only when awaited.
- `flow-send`: all except `fallback`, except that `to` accepts a `{ channel }` fallback.
- A profile resolved onto an edge that refuses one of its primitives fails boot (`PRIMITIVE_NOT_ALLOWED`) when that profile was set at L4. When the primitive comes from L1..L3, it is dropped with one boot warning.

## 5. Graph annotations and boot validation

### 5.1 `GET /integration/graph` additions (names only, never values)

```ts
// each GraphFlowEntry.steps[i] (from describe(), recorded by recordFlow, channel-graph.ts:125)
{ kind: 'jump', id: 'credit', dests: [{ channel: 'credit.check',
    policy: 'jump-sla+inline',                 // describePolicy (RS-42): profile names, 'inline', or 'module:flow-jump'
    retryGate: 'key' | 'declared' | 'none',
    sensitive: ['secrets@1', 'pii'],           // profile and pack names; 'inline' for inline rules
    idempotency: { scope: 'flow:loan#credit', store: 'shared', storeKind: 'redis', visibility: 'shared' } }] }
// GraphFlowEntry gains: options?: { policy?: {...}; sensitive?: string[]; idempotency?: {...} }
// GraphNode gains: sensitive?: string[]; delivery?; sideEffects?; policy?: string; store?: string
// GraphSnapshot gains: module: { replicas: 'single'|'multi'; stores: { name; kind; visibility }[];
//                               policies: string[]; profiles: string[] }
// GraphInboundRef / GraphOutboundRef gain policy?: string (RS) and sensitive?: string[]
```

The graph never contains:
- regex sources or field paths;
- inline policy values, fallback values or `classify` functions;
- keys or key labels;
- store connection data;
- `allow` reasons.

`storeKind` comes from a new optional `readonly kind?: string` on `IdempotencyStore`, which is additive. The shipped stores set `'memory'`, `'redis'`, `'postgres'` and `'noop'`. A store without it shows `'custom'`.

### 5.2 Boot validation

A single `FlowParameterResolver` runs in `IntegrationRuntime.onModuleInit` (`integration.module.ts:245`). It runs after channels are created (step 1) and before flows attach (step 3). It resolves every reference and freezes the plans. A flow's `build()` is therefore validated before `attachTo`.

All findings are collected, then reported:
- If any finding is an error, the resolver throws the error class of its concern: `ResilienceDefinitionError`, `SensitiveConfigError`, `ReplicaConfigError` or `FlowDefinitionError`. The `findings` property lists every finding, and the message names the subject and the option path, for example `flow 'loan' step 'credit': resilience.use unknown profile 'jump-slo'`.
- Warnings are logged once each.

| Code | Level |
|---|---|
| `UNKNOWN_PROFILE` (resilience policy, sensitive profile or store name) | error |
| `PROFILE_CYCLE`, `PROFILE_DEPTH` | error |
| `PRIMITIVE_NOT_ALLOWED` (L4), `WIRETAP_RESILIENCE`, `LEGACY_AND_NEW_SAME_LAYER` | error |
| `MASK_PAYLOAD_LEVEL`, `SENSITIVE_FALSE_BELOW_MODULE`, missing `applyReason`, `redactReason` or `storeModeReason` | error |
| `FALLBACK_CHANNEL_MISSING`, `DUPLICATE_STEP_ID`, the 5.6 rules of RS-03 applied to every resolved plan | error |
| `RETRY_WITHOUT_KEY_GATE`, `RETRY_STACKED`, primitive dropped from L1..L3 | warning |
| `STORE_REF_UNRESOLVED` (a `{ useExisting }` store) | deferred to `onApplicationBootstrap`, where the replica guard (MR 3.13) also receives every step and flow store as a `subject` |

Ad-hoc `request()` call options are still validated on the first call (RS-03, RS-33). Profile names in them are checked against the frozen registry at that point and throw `UNKNOWN_PROFILE`.

**Notes:**
- **Conflict in the resilience spec:** this model adds `policies`/`defaults` to `ResilienceModuleOptions`, the `flow-*` edge kinds, and policies on flow steps. The resilience spec today lists none of these. Its section 2.9 (RS-33..39) and 5.5 table need rows for the three new edge kinds, or this has to be marked a follow-up there.
- **Choice to confirm:** rule 4.2 keeps `retry.idempotent: true` as a declared way out of the key requirement, to match RS-09/RS-36. If you want a hard "key only" rule, remove option (c) from 4.2. RS-36 would then need the same change for activators.
- **Other spec edits:** the sensitive spec's 6.6 table needs flow and step rows. Its `wireTap(channel, { redact })` becomes the shape in 3.1. The multi-replica spec needs `stores` by name and the store `kind` label. The KA- adoption spec should reference profiles by name only.
