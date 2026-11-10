# ESTELA flow parameter model (shared by SPI-433, SPI-429, SPI-445 and the KA- adoption spec)

Status: proposal. It is checked against the code at `estela-wt-SPI-428` (0.9.0). Amended 2026-11-10: the care concern (SPI-445) uses the Estela-own vocabulary (decision FP-D1), and so does the privacy concern (SPI-433, decision FP-D2); SPI-445 lands first and ships the shared scaffolding, and SPI-433 adds the privacy members to it (FP-D3). It does not replace any rule in the three library specs. It names the levels, the merge rule for each concern, the profile references, and the option shapes a flow author writes. Each spec should link this model instead of restating these rules.

The normative requirements live in the library specs: `ESTELA_SENSITIVE_DATA_SPEC.md` section 18 (SPI-433, which adds the privacy members to the shared scaffolding, SD-67), `ESTELA_RESILIENCE_SPEC.md` section 2.13 (SPI-445, which ships the shared scaffolding first) and `ESTELA_MULTI_REPLICA_SPEC.md` section 16 (SPI-429). When this document and a spec disagree, the spec wins and this document is corrected. This file is the proposed answer to the location question (SD Q12, RS OQ-16, MR OQ-14).

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

None of the flow DSL methods accepts a care, privacy or idempotency option in 0.9.0. This model adds them. Every addition is an optional trailing parameter.

## 1. Levels and precedence

### 1.1 Levels (highest wins)

| # | Level | Where it is written |
|---|---|---|
| L5 | **call** | `OutboundRestCallOptions` / ad-hoc `request()` options; SDK and gRPC call options (SPI-430/436). A flow step has no call level. |
| L4 | **step / endpoint** | a DSL step option; one fanout or jump target; `@ServiceActivator`; `@InboundRest`/`@InboundGrpc` spec; `OutboundRestBinding`/`@OutboundRest`; a saga `.outbound` step. |
| L3 | **flow** | `IntegrationFlow.from(source, options)` (new, section 3.2) |
| L2 | **channel** | `ChannelSpec` in `forRoot({ channels })` |
| L1 | **module** | `forRoot({ care, privacy, idempotency, replicas, outbound.rest.defaults, inbound })` |
| L0 | **built-in** | the defaults in each spec (for example RS-01 "no primitive, one attempt"; SD baseline `secrets@1` plus `DEFAULT_HIDDEN_HEADERS`; MR `'fail-closed'`, `'single'`) |

**Which channel is L2:**
- For a send step (`to`, `publish`, `route`, `fanoutTo`, `jumpTo`), it is the **destination** channel.
- For `handle`, `filter`, `transform` and the flow claim, it is the flow's **source** channel.
- For an activator or inbound endpoint, it is its own channel.

**Runtime caps are not levels.** The remaining deadline, the incoming `x-tries-left` (RS-29..31), and a `sideEffects` channel's fail-closed rule (MR) only narrow a resolved value. They never widen it.

### 1.2 Merge semantics per concern

| Concern | Across levels | Inside one reference (`use` plus inline) | `false` |
|---|---|---|---|
| **Care** | **Per-part replace.** The highest level that sets `patience`, `tries`, `valve`, `lanes`, `pace`, `planB` or `classify` owns that key whole. Other parts keep inheriting. There is no field-level merge across levels, which matches today's "not inherited when a binding passes an object" (`outbound.types.ts:250,268`). | **Deep merge, one time only.** Inline fields merge into the named profile's part field by field. Arrays and functions replace. `false` replaces. | `care: false` means no care at this level and below: one direct try. `tries: false` disables only that part. |
| **Privacy** | **Union, stricter wins** (SD-17, unchanged). `fields`, `headers`, `patterns` and `packs` are unioned. Per path, the stricter `show` wins (`Omitted > Hidden = Text > Length > Fingerprint > Ends`). `exempt` is the only way to weaken, and it applies to its own level and the levels inside it. `remember` comes from the most specific level that sets it. | Same union rule. A list `use: ['personal','secrets']` unions the profiles in order. | Only valid at L1 (`forRoot({ privacy: false })`, the switch that turns off the baseline). At L2..L5 it is a boot error (`PRIVACY_FALSE_BELOW_MODULE`). Use `exempt` with a `reason` instead. |
| **Idempotency / store** | **Per-key replace** (`ttlMs`, `store`, `onStoreUnavailable`, `scope`, `key`). | Not applicable. Stores are referenced by name only. | `idempotency: false` turns off this level's claim only. It never turns off an outer claim, such as the flow claim under a step claim. |
| **Replicas** | **Module only.** `replicas` exists only at L1, or through `ESTELA_REPLICAS` (MR-22). | Not applicable. | Not applicable. |

**Floors that no lower level can lift:**
- `ChannelSpec.sideEffects: true` keeps the scope fail-closed.
- `delivery: 'must-not-lose'` is refused for in-memory kinds when `replicas: 'multi'`.
- The privacy baseline stays on unless the module sets `privacy: false`.
- `remember: Remember.Everything` needs `rememberReason`.

## 2. Named reusable profiles (L1)

```ts
// Profile names: ^[a-z0-9][a-z0-9._-]{0,63}$ (the grammar of PatternRule.name).
export type ProfileName = string;

export interface CareProfile extends Care {
  /** Single inheritance, resolved at boot; cycles and depth > 8 fail boot. */
  extends?: ProfileName;
}
export interface PrivacyProfile extends Privacy {
  extends?: ProfileName | readonly ProfileName[];
}

// forRoot additions (all optional, additive)
export interface CareModuleOptions /* SPI-445 3.1 */ {
  profiles?: Readonly<Record<ProfileName, CareProfile>>;
  /** L1 defaults per edge; a value is a profile name or an inline `Care`. */
  defaults?: Partial<Record<CareEdge, CareRef>>;
}
export interface PrivacyModuleOptions /* SPI-433 4.1 */ {
  profiles?: Readonly<Record<ProfileName, PrivacyProfile>>;
}
export interface IntegrationIdempotencyOptions /* SPI-429 3.13 */ {
  /** Named stores; `store` (the module store) may then be a name. */
  stores?: Readonly<Record<ProfileName, IdempotencyStore | InboundProviderRef<IdempotencyStore>>>;
  store?: IdempotencyStore | ProfileName;
}

// References accepted at L2..L5
export type CareRef =
  | ProfileName
  | (Care & { use?: ProfileName })
  | false;
export type InboundCareRef =
  | ProfileName                      // profile must hold only lanes/pace (RS-37)
  | (InboundCare & { use?: ProfileName })
  | false;
export type PrivacyRef =
  | ProfileName
  | readonly ProfileName[]
  | (Privacy & {
      use?: ProfileName | readonly ProfileName[];
      /** Reach.Trail (default) | Reach.Delivery (L4 only, section 4.4). */
      reach?: Reach;
      reachReason?: string;          // required with Reach.Delivery, logged at boot
    });
export type StoreRef = ProfileName | IdempotencyStore | InboundProviderRef<IdempotencyStore>;
```

New edge kinds extend `CareEdge` (SPI-445 3.1): `'flow-handle' | 'flow-jump' | 'flow-send'`. The defaults map uses them as keys.

Example:

```ts
IntegrationModule.forRoot({
  care: {
    profiles: {
      'http-std': { patience: { eachTryMs: 2000, totalMs: 8000 }, tries: { max: 3 } },
      'http-guarded': { extends: 'http-std', valve: { shutMs: 30000 } },
      'jump-sla': { patience: { eachTryMs: 3000 }, tries: { max: 2 },
                    planB: { value: () => ({ status: 'unknown' }) } },
    },
    defaults: { 'outbound-rest': 'http-std', 'flow-jump': 'jump-sla' },
  },
  privacy: {
    packs: [Pack.SecretsV1],
    profiles: {
      personal: { packs: [Pack.PersonalV1] },
      card: { fields: [{ path: '**.pan', show: Show.Ends, showLast: 4 }] },
    },
  },
  idempotency: { stores: { shared: redisStore, ledger: pgStore }, store: 'shared', ttlMs: 3_600_000 },
  replicas: 'multi',
  channels: [
    { name: 'payments.charge', type: 'direct', sideEffects: true,
      privacy: 'card', care: 'http-guarded', idempotency: { store: 'ledger' } },
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
  /** Privacy of this step's trail copies (hop log, error envelope, events). */
  privacy?: PrivacyRef;
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
  care?: CareRef;
  privacy?: PrivacyRef;
}
export type FlowDest = string | FlowTarget;
```

| DSL method (new signature) | `care` | `privacy` | `idempotency` | Notes |
|---|---|---|---|---|
| `filter(predicate, opts?: StepCommonOptions)` | no | yes | no | A pure function: retrying it adds nothing. |
| `transform(fn, opts?: StepCommonOptions)` | no | yes, and `reach: Reach.Delivery` | no | Use `handle` for side effects. |
| `handle(fn, opts?: StepCommonOptions & { care?: CareRef; idempotency?: false \| StepIdempotencyOptions })` | yes, all parts (`flow-handle`, `defaultInProcessClassifier`) | yes, and delivery-reach on its output | yes | Retry happens between the step `claim` and `complete`, so it never claims twice (same shape as RS-36). |
| `wireTap(channel, opts?: StepCommonOptions & { copy?: TapCopy; copyReason?: string })` | **never** | yes; the tap copy is `TapCopy.AsShown` under explicit privacy (SD-52) | no | See rule 4.1. `copy: TapCopy.Original` needs `copyReason`. |
| `fanoutTo(dests: FlowDest[], opts?: StepCommonOptions & { care?: CareRef })` | yes, per target (`flow-send`); no `planB` | yes, per target | inherited from the message key | `wait: false` targets: resilience still applies, but failures still go to error.channel (`forget.ts:15-24`). |
| `jumpTo(dests: FlowDest[], opts?: …same)` and `jump(channel, { wait?, timeoutMs?, care?, privacy?, id? })` | yes, all parts (`flow-jump`); `planB` only on awaited targets | yes | inherited | See rule 4.5. |
| `publish(channel, routingKey?, opts?)` and `publish(channel, opts)` | yes (`flow-send`); no `planB` | yes, and delivery-reach on the hop copy | inherited | Overload: a string second argument is the routing key. |
| `route(fn, opts?: StepCommonOptions & { care?: CareRef })` | yes, per resolved target; no `planB` | yes | inherited | The policy is resolved per target channel at run time. Profile names are still validated at boot. |
| `to(channel, opts?: StepCommonOptions & { care?: CareRef })` | yes (`flow-send`); `planB` only as `{ channel }` | yes, and delivery-reach | inherited | Terminates the flow, as today (`to.step.ts:23`). |
| `reply(options?: ReplyOptions & { id?: string })` | no | no | no | The reply payload goes to the caller, so it is never redacted (rule 4.4). |

`ReplyOptions` keeps `payload` (`reply.step.ts:3-6`).

On `jump` and `jumpTo`, a target's `timeoutMs` is the **0.9.0 spelling** of `care.patience.eachTryMs`. Setting both on the same target is refused (`LEGACY_AND_NEW_SAME_LAYER`, the RS-35 rule).

### 3.2 Flow-level defaults (L3)

```ts
export interface FlowOptions {
  /** Per step family: one flow default cannot leak a part into a step that refuses it. */
  care?: { handle?: CareRef; jump?: CareRef; send?: CareRef };
  privacy?: PrivacyRef;                      // reach: Reach.Delivery refused here
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
  privacy?: PrivacyRef;                       // SPI-433 (a name, a list or an inline Privacy)
  /** Default for flow steps that send INTO this channel and for activators ON it. */
  care?: CareRef;
  idempotency?: { store?: StoreRef; ttlMs?: number; onStoreUnavailable?: StoreUnavailablePolicy };
}
```

Channel `care` is never applied to inbound endpoints. Inbound endpoints accept only `lanes` and `pace` (RS-37), and that comes from `InboundDefaults` or `InboundSpec`.

### 3.4 Decorators and adapters (L4)

```ts
// decorators.ts
export interface ActivatorOptions {
  group?: string; routingKey?: string;
  care?: CareRef;            // RS-36 semantics
  privacy?: PrivacyRef;              // SD scope activator:<Class>.<method>
  idempotency?: { store?: StoreRef; ttlMs?: number; onStoreUnavailable?: StoreUnavailablePolicy };
}
// inbound/inbound.types.ts (InboundRest / InboundGrpc / InboundGraphQL)
export interface InboundSpec { /* existing */ care?: InboundCareRef; privacy?: PrivacyRef }
export interface InboundIdempotencyOptions { /* existing */ store?: StoreRef /* name allowed */; remember?: Remember; onStoreUnavailable?: StoreUnavailablePolicy }
export interface InboundDefaults { /* existing */ care?: InboundCareRef; privacy?: PrivacyRef }
// outbound/outbound.types.ts
export interface OutboundRestOptions { /* existing */ care?: CareRefOf<OutboundRestCare>; privacy?: PrivacyRef }
export interface OutboundRestCallOptions { /* existing */ care?: CareRefOf<OutboundRestCare> /* RS-33 limits */; privacy?: PrivacyRef }
// adapters/grpc.adapter.ts (the engine is wired by SPI-430; the shape is fixed here)
bindGrpcOut(registry, fromChannel, stub, options?: { replyChannel?: string; id?: string; care?: CareRef; privacy?: PrivacyRef })
// saga/saga.ts
export interface OutboundOptions<Ctx, Tx> { /* existing */ care?: CareRef }   // profile with planB => SagaDefinitionError
SagaRunnerOptions.privacy.rules?: PrivacyRef   // names resolve only when `engine` is passed
```

`@InboundRabbit` with any `care` is a boot error (RS-37).

## 4. Semantic rules

**4.1 wireTap never carries care.**
- The type has no field for it.
- A JS caller passing `care` gets `FlowDefinitionError(WIRETAP_CARE)` when the flow is built.
- Flow and channel `care` defaults skip wireTap, including a channel default on the tap's destination channel.
- The tap stays fire-and-forget and swallows failures (`wire-tap.step.ts:16`).
- When the module has care, the tap copy does not spend or forward the tries left: the `triesLeft` header is removed from the copy.

**4.2 A step tries again only under an idempotency key.** A try after the first runs only when one of these holds:
- (a) the message carries `headers.idempotencyKey` (propagated by `nextHop`, `message.ts:155`);
- (b) the step's `idempotency.key` resolves a non-empty key;
- (c) the step's care declares `tries.idempotent: true`. This is the RS-09/RS-36 escape hatch. It is logged at boot and shown in the graph as `repeatableBy: 'declared'`.

Otherwise `tries.max` is reduced to 1 at run time and `try.held` is emitted. Step care with `tries.requireIdempotencyKey: true` fails before the first try instead (RS-48).

Boot warning `TRIES_WITHOUT_KEY`: `tries.max > 1` on a step whose flow has no idempotency and no `idempotent: true`.

Boot warning `TRIES_STACKED`: a send step with extra tries toward a channel whose bound activator or outbound binding also tries again. Tries left (RS-29..31) bound the amplification at run time.

**4.3 A plan B answer is never stored as an idempotent result** (RS-27). When any `planB` fires during a run, `CareScope.markPlanB()` marks the scope. On a marked run:
- the step claim and the flow claim settle with `fail` (or `release` when the store has it), not `complete`, so a redelivery with the same key runs again;
- an activator never writes `cachedResult` (`activator-wrapper.ts:99-104`);
- inbound `onDuplicate: 'replay'` never replays it.

`planB.cacheable: true` is the only opt-out. It is logged at boot.

The plan B value:
- on `jump`, lands in `headers.jumpReplies[channel]` with `headers.jumpPlanB[channel] = true`;
- on `handle`, becomes the payload.

**4.4 Privacy applies to the trail, not to deliveries.** The trail is everything Estela itself writes. The effective privacy (L1..L4, union) is applied to copies written to:
- hop logs (`hop-logger.ts`);
- error.channel envelopes (`flow-executor.ts:139-150`, `forget.ts:16-24`, `integration.module.ts:161-171`, and the error.channel logger at `:253-255`);
- wireTap copies;
- care events;
- graph describe output.

It **never** changes the payload or headers delivered to handlers, next steps, `to`/`publish`/`route`/`fanoutTo`/`jumpTo` destinations, outbound calls or `reply`. Copy-on-write sharing (SD 6.2 step 4) guarantees this.

The single exception is `privacy: { reach: Reach.Delivery, reachReason }` on an L4 step, which hides, with that step's own rules only:
- the output of `transform` or `handle`;
- or the hop copy sent by `publish`, `to`, `fanoutTo` or `jumpTo`.

`Reach.Delivery` at L1, L2 or L3, on `filter`, `wireTap`, `route` or `reply`, or without `reachReason`, is a boot error (`DELIVERY_REACH_LEVEL`). A tap copy is shown with the privacy of (module, tap channel, flow, step; SD-52 also adds the flow's source channel). `copy: TapCopy.Original` needs `copyReason` (`COPY_REASON_MISSING`).

**4.5 jumpTo care wraps send plus await reply.** For each awaited target, one try is:
1. open a new `reply.<uuid>` channel;
2. send the hop;
3. await the first reply under `eachTryMs`, which defaults to target `timeoutMs`, else 10 000 (`jump.step.ts:13,36`);
4. in `finally`, cancel the wait and unregister the channel (`:73-77`).

The other steps of the call:
- `totalMs` covers every try and every gap between tries.
- A late reply to an earlier attempt reaches an unregistered channel and is dropped.
- `JumpTimeoutError` (`flow-step.ts:55`) is classified `transient` by the `flow-jump` adapter.
- Targets with `wait: false` run the same attempt loop in the background. They refuse `planB`, and their final failure goes to error.channel as today (`jump.step.ts:38`).
- Sibling targets of one `jumpTo` resolve their care independently, and `Promise.all` still joins them (`:43`).

**4.6 Allowed parts per edge.** This is the RS-05/5.5 table extended:
- `flow-handle`: all parts.
- `flow-jump`: all parts; `planB` only when awaited.
- `flow-send`: all except `planB`, except that `to` accepts `planB: { channel }`.
- A profile resolved onto an edge that refuses one of its parts fails boot (`CARE_PART_NOT_ALLOWED`) when that profile was set at L4. When the part comes from L1..L3, it is dropped with one boot warning (`CARE_PART_DROPPED`).

## 5. Graph annotations and boot validation

### 5.1 `GET /integration/graph` additions (names only, never values)

```ts
// each GraphFlowEntry.steps[i] (from describe(), recorded by recordFlow, channel-graph.ts:125)
{ kind: 'jump', id: 'credit', dests: [{ channel: 'credit.check',
    care: 'jump-sla+inline',                   // profile names, 'inline', or 'module:flow-jump' (RS-42, OQ-13)
    repeatableBy: 'key' | 'declared' | 'none',
    privacy: ['secrets@1', 'personal'],           // profile and pack names; 'inline' for inline rules
    idempotency: { scope: 'flow:loan#credit', store: 'shared', storeKind: 'redis', visibility: 'shared' } }] }
// GraphFlowEntry gains: options?: { care?: {...}; privacy?: string[]; idempotency?: {...} }
// GraphNode gains: privacy?: string[]; delivery?; sideEffects?; care?: string; store?: string
// GraphSnapshot gains: module: { replicas: 'single'|'multi'; stores: { name; kind; visibility }[];
//                               careProfiles: string[]; privacyProfiles: string[] }
// GraphInboundRef / GraphOutboundRef gain care?: string (RS) and privacy?: string[]
```

The graph never contains:
- regex sources or field paths;
- inline care values, plan B values or `classify` functions;
- keys or key labels;
- store connection data;
- `exempt` reasons, `reachReason`, `copyReason` or `rememberReason`.

`storeKind` comes from a new optional `readonly kind?: string` on `IdempotencyStore`, which is additive. The shipped stores set `'memory'`, `'redis'`, `'postgres'` and `'noop'`. A store without it shows `'custom'`.

### 5.2 Boot validation

A single `FlowParameterResolver` runs in `IntegrationRuntime.onModuleInit` (`integration.module.ts:245`). It runs after channels are created (step 1) and before flows attach (step 3). It resolves every reference and freezes the plans. A flow's `build()` is therefore validated before `attachTo`.

All findings are collected, then reported:
- If any finding is an error, the resolver throws the error class of its concern: `CareConfigError`, `PrivacyConfigError`, `ReplicaConfigError` or `FlowDefinitionError`. The `findings` property lists every finding, and the message names the subject and the option path, for example `flow 'loan' step 'credit': care.use unknown profile 'jump-slo'`.
- Warnings are logged once each.

| Code | Level |
|---|---|
| `UNKNOWN_PROFILE` (care profile, privacy profile or store name) | error |
| `PROFILE_CYCLE`, `PROFILE_DEPTH`, `PROFILE_NAME` | error |
| `CARE_PART_NOT_ALLOWED` (L4), `WIRETAP_CARE`, `LEGACY_AND_NEW_SAME_LAYER` | error |
| Privacy (concern `'privacy'`, SD 4.7): `DELIVERY_REACH_LEVEL` (also a missing `reachReason`), `PRIVACY_FALSE_BELOW_MODULE`, `PRIVACY_OFF_WITH_REFS`, `REMEMBER_LEVEL`, `EXEMPT_REASON_MISSING`, `REMEMBER_REASON_MISSING`, `COPY_REASON_MISSING`, `FINGERPRINT_WITHOUT_SECRET`, `FINGERPRINT_SECRET_SHORT`, `SEALED_WITHOUT_KEYS`, `OUTCOME_ONLY_REPLAY`, `INVALID_SELECTOR`, `PROTECTED_TRACE_FIELD`, `UNKNOWN_PACK`, `RULE_NAME`, `UNSAFE_PATTERN` | error |
| `PLAN_B_CHANNEL_MISSING`, `DUPLICATE_STEP_ID`, the 5.6 rules of RS-03 applied to every resolved plan | error |
| `TRIES_WITHOUT_KEY`, `TRIES_STACKED`, `CARE_PART_DROPPED` (a part dropped from L1..L3), `TRIES_DECLARED_IDEMPOTENT`, `PLAN_B_CACHEABLE` | warning |
| `STORE_REF_UNRESOLVED` (a `{ useExisting }` store) | deferred to `onApplicationBootstrap`, where the replica guard (MR 3.13) also receives every step and flow store as a `subject` |

Ad-hoc `request()` call options are still validated on the first call (RS-03, RS-33). Profile names in them are checked against the frozen registry at that point and throw `UNKNOWN_PROFILE`.

**Notes:**
- **Conflict in the resilience spec:** this model adds `profiles`/`defaults` to `CareModuleOptions`, the `flow-*` edge kinds, and care on flow steps. The resilience spec today lists none of these. Its section 2.9 (RS-33..39) and 5.5 table need rows for the three new edge kinds, or this has to be marked a follow-up there.
- **Choice to confirm:** rule 4.2 keeps `tries.idempotent: true` as a declared way out of the key requirement, to match RS-09/RS-36. If you want a hard "key only" rule, remove option (c) from 4.2. RS-36 would then need the same change for activators.
- **Other spec edits:** the privacy spec's 6.6 table needs flow and step rows. Its `wireTap(channel, { copy })` takes the shape in 3.1. The multi-replica spec needs `stores` by name and the store `kind` label. The KA- adoption spec should reference profiles by name only.

## 6. Decisions log

| # | Question | Decision | Reason |
|---|---|---|---|
| FP-D1 | Estela-own vocabulary (2026-11-10) | The care concern uses the Estela vocabulary of `ESTELA_RESILIENCE_SPEC.md` section 18 (D34 there): the option key is `care` on every level (`forRoot({ care })`, `ChannelSpec.care`, `FlowOptions.care`, step and target `care`, decorators and saga steps); its parts are `patience`, `tries`, `valve`, `lanes`, `pace` and `planB`; profiles live in `care.profiles`; the graph shows `care` and `repeatableBy` and the module lists `careProfiles`; finding codes are `WIRETAP_CARE`, `CARE_PART_NOT_ALLOWED`, `CARE_PART_DROPPED`, `PLAN_B_CHANNEL_MISSING`, `TRIES_WITHOUT_KEY` and `TRIES_STACKED`, with concern `'care'`. The shared grammar (`ProfileName`, `use`, `extends`, `false`) and the shared codes (`UNKNOWN_PROFILE`, `PROFILE_CYCLE`, `PROFILE_DEPTH`, `DUPLICATE_STEP_ID`, `LEGACY_AND_NEW_SAME_LAYER`) are unchanged. The jump target `timeoutMs` stays as the 0.9.0 spelling of `care.patience.eachTryMs` | Owner decision 2026-11-10; the names read without the docs and match `privacy` and `idempotency`. The care names never shipped, so there are no aliases |
| FP-D2 | Estela-own vocabulary for private data (2026-11-10) | The privacy concern uses the vocabulary of `ESTELA_SENSITIVE_DATA_SPEC.md` section 19 (D22 there): the option key is `privacy` on every level (`forRoot({ privacy })`, `ChannelSpec.privacy`, `FlowOptions.privacy`, step and target `privacy`, `jump` options, decorators, bindings, `bindGrpcOut`, `SagaRunnerOptions.privacy`); references are `PrivacyRef` and profiles `PrivacyProfile` in `privacy.profiles`; values are shown with `Show` (`Hidden`, `Omitted`, `Ends`, `Fingerprint`, `Length`, `Text`); durable scopes keep `remember: Remember`; `exempt` replaces `allow`; `reach: Reach.Trail \| Reach.Delivery` replaces `apply`; the tap takes `copy: TapCopy.AsShown \| TapCopy.Original` with `copyReason`; the graph shows `privacy` and the module lists `privacyProfiles`; finding codes are those of SD 4.7, with concern `'privacy'` (the earlier `'sensitive'` member never shipped). The shared grammar and codes are unchanged | Owner decision 2026-11-10; everyday words that sit next to `care` and do not give away the mechanism. No aliases |
| FP-D3 | Who ships the shared scaffolding (2026-11-10) | SPI-445 lands first and ships it with care members only (`FlowOptions`, `StepCommonOptions`, `FlowTarget`/`FlowDest`, `JumpOptions`, `ProfileName`, `FlowParameterFinding`, `FlowDefinitionError`, the care-only `FlowParameterResolver`). SPI-433, stacked on SPI-445, adds the `privacy` members and the privacy pass (SD-67); SPI-429 adds the `idempotency` members later. Nobody re-creates a shared type | SPI-445 merged first in practice; one owner keeps RS-57, RS-66 and RS-67 in one place. Replaces the earlier plan in which SPI-433 shipped the scaffolding |
