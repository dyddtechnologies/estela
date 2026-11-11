# Estela: sensitive-data policy spec

Status: draft, not implemented. Base: `20ae298` (`chore(release): 0.9.0`), branch

Shared flow parameter model: [`ESTELA_FLOW_PARAMETERS.md`](./ESTELA_FLOW_PARAMETERS.md) (proposed location; see the open location question).
`docs/SPI-428-koletz-readiness-specs`. Ticket: **SPI-433** (epic SPI-428). Requirement prefix: `SD-`.
Highest risk of the SPI-428 series (P0); lands second, after SPI-445 (section 12). Release type: minor (`feat`), with three `fix`
commits for the leaks in section 0.3 (S3, S11, S12). Cross-spec consistency pass (2026-11-09, with
SPI-445, SPI-429 and the KA- spec): SD-55 is marked "(amended)"; Q10 is resolved; Q14 and Q17 take
the defaults of RS-67 and RS-66. Second pass (2026-11-09): SD-67 is new; section 4.8 takes the `id`
rule of RS-66. Vocabulary and delivery amendment (2026-11-10, D22): every public name follows the
Estela-own privacy vocabulary of section 19 (`privacy`, `Show`, `Remember`, `Reach`, `TapCopy`,
`PrivacyEngine`, the trail); requirements whose text changed are marked "(amended)" and keep their
IDs. SPI-433 now lands **after** SPI-445 (branch `feat/SPI-433-sensitive` stacked on
`feat/SPI-445-resilience`): the shared flow parameter scaffolding already exists from SPI-445 and
this ticket adds the privacy members to it (SD-67, amended; section 12).

This spec replaces section 5 of the combined readiness draft
(`voice-plat/docs/superpowers/specs/2026-11-09-estela-koletz-readiness.md`). It is generic library
work: the Koletz rules (its regex pack, its per-channel table, guardrail 9) live only in the Koletz
adoption spec (`KA-` requirements), never here.

## 0. Motivation and scope

### 0.1 Problem

Estela 0.9.0 has no notion of sensitive data. Every place where Estela itself writes a value outside
the live call (a log line, a stored idempotency record, a saga ledger row, a wire-tap copy) writes it
verbatim. Consumers that carry decrypted credentials and personal data through Estela (provider API
keys, messaging-provider auth tokens, phone numbers, emails, transcripts) would leak them into logs
and stores as soon as they adopt it. Turning logging off is not an acceptable answer: operators need
the hop lines, ids and error lines. The policy below keeps every sink on and writes a redacted copy.

**The trail** is everything Estela itself writes: logs, idempotency records, saga ledgers, wire-tap
copies, error envelopes and test captures. Privacy rules apply to the trail, never to the data a
handler or a remote service receives (the one exception is `Reach.Delivery`, SD-50). In this spec
"sink" names one place of the trail (S1 to S15) and `TrailOutput` names its kind.

### 0.2 Verified premise

- The risk does not depend on the replica count. The first adopters (ms-ai-core, ms-campaigns) run one
  replica each in dev and qa with no HPA (verified 2026-11-09); a single pod already writes the sinks
  below. Multi-replica correctness is SPI-429 and is not a precondition for this ticket.
- Hop lines never print payloads today: `HopLogger` prints channel, target, `traceId` and
  `correlationId` only (`src/trace/hop-logger.ts:31-53`). Payload values reach logs through error
  text and error objects, not through hop lines.
- `HopLogger.hopError` has exactly one caller in 0.9.0: `SagaTracer.error`
  (`src/saga/saga-tracer.ts:32`). Flows, activators and outbound calls log failures only as
  `flowEnd ... error` / `hopEnd ... FAIL` (no error text, `flow/flow-executor.ts:101`,
  `activator/activator-wrapper.ts:136`, `outbound/outbound.call.ts:210`); their error text reaches
  logs through `error.channel` (S3).
- Message `history` entries hold `channel`, `at`, `component` and `adapter` only
  (`message.ts:98-103`): history is not a payload sink.

### 0.3 Sinks in 0.9.0 (verified against the code)

| # | Sink | Code | What it writes today |
|---|---|---|---|
| S1 | Hop error line (saga failures with a hop logger: checkpoint, ledger release, lock release, afterCommit, `unit-of-work.ts:136,240,265,291,302`) | `trace/hop-logger.ts:56-62` | `error.name`, `error.message` and the full `stack`, verbatim |
| S2 | Saga fallback error line | `saga/saga-tracer.ts:30-40` | `error.message` and `stack`, verbatim |
| S3 | Default `error.channel` logger | `integration.module.ts:253-255` | `JSON.stringify(msg.payload)`. Flow failures put the **raw** error object in the envelope (`flow/flow-executor.ts:140-142`), so every own enumerable property is printed. For an `OutboundHttpError` that is `url` (full, with query string, although `outbound/outbound.errors.ts:12` promises it is never in `message`), response `headers` (`set-cookie`) and `body` (`outbound.errors.ts:51-61`). **Leak today.** |
| S4 | `error.channel` envelopes (as messages) | `integration.module.ts:161-170`, `activator/activator-wrapper.ts:176-197`, `flow/flow-executor.ts:139-150` | `serializeError` (name + message, `flow/flow-step.ts:63-66`) for registry and activator errors, and `{ value: <raw thrown value> }` when the thrown value is not an `Error` (`flow-step.ts:65`); the raw error for flow errors |
| S5 | Inbound explorer error line | `integration.module.ts:200` | `String(error)` |
| S6 | Inbound idempotency records | `inbound/inbound.interceptor.ts:163,166`; `inbound/inbound.idempotency.ts:231-252,262-265` | `{ cachedResult: <full reply> }`; on failure the raw error object (`store.fail`) or `failureCodec.serialize(error)` (HTTP status + body, `inbound/inbound.failure.ts:93-99`) |
| S7 | Activator idempotency records | `activator/activator-wrapper.ts:86,101-105,110,160-174` | `{ cachedResult: <activator result> }`, raw error on failure; the cached result is re-sent to the reply channel on a duplicate (`resendCachedResult`) |
| S8 | Flow idempotency records | `flow/flow-executor.ts:70-81` | `{ completed: true }` / `{ filtered: true }` (no payload) and the raw error on failure |
| S9 | Saga idempotency ledger | `saga/idempotency-ledger.ts:23`, `saga/saga-runner.ts:370-378` | the saga reply, verbatim, replayed on a repeat |
| S10 | Wire-tap copies | `flow/steps/wire-tap.step.ts:14-17`, `message.ts:139-141` | the **same payload reference** and a copy of the headers |
| S11 | Error messages built by Estela | `adapters/rest.adapter.ts:49` | `restOut ${method} ${options.url}`: full url, query secrets and userinfo included. **Leak today.** |
| S12 | Error messages and properties that carry keys | `saga/idempotency-ledger.ts:28-37`; `inbound/inbound.failure.ts:48-58` | `IdempotencyInProgressError` (thrown by `SagaRunner.run`, `saga-runner.ts:361`) puts the idempotency key in `message` (`${scope}/${key}`) and in the enumerable `key` property; a saga run from an activator turns it into an S4 envelope (`serializeError` keeps the message) and an S3 line. **Leak today.** `InboundIdempotencyInFlightError` keeps the key out of `message` (`IDEMPOTENCY_KEY_IN_PROGRESS: ${channel}`) but holds `clientKey` as an enumerable property; it is thrown before dispatch, so it reaches the app's exception filters and Nest's handler (section 1.3), and S3 only if app code forwards it into a flow |
| S13 | Topology graph | `graph/channel-graph.ts:14-18` | names and redacted targets only, never payloads. **Unchanged.** |
| S14 | Test captures | (new in this ticket) | n/a today |
| S15 | Boot inbound-discovery warn line **(added 2026-11-09)** | `integration.module.ts:347-350` | `inbound discovery skipped: ${String(error)}`, verbatim; boot-time only (SD-66) |

Message headers are not a sink by themselves: inbound header mappers copy only the trace headers and
the idempotency key, which they store under the message header `idempotencyKey`
(`adapters/header-mapper.ts:38-51`). Headers become sink content when a sink writes them (S10, and
any sink that receives a whole message) or when app code puts custom headers on a message
(`message.ts:130-134` copies unknown header keys).

### 0.4 Scope (one deliverable: SPI-433)

1. Field marking: `@Private()` on DTO properties, path selectors with `[*]` and `**`, a header
   denylist (`DEFAULT_HIDDEN_HEADERS`).
2. Regex rules applied on the way, at any depth, including error messages, stacks and error properties.
3. Built-in packs `secrets` and `personal` (versioned). No product-specific pack.
4. Show values `Show.Hidden`, `Show.Omitted`, `Show.Ends`, `Show.Fingerprint` (HMAC through a `FingerprintSecretProvider` port), `Show.Length`,
   `Show.Text`.
5. Coverage of sinks S1 to S12 and S14.
6. `remember` for durable sinks (S6 to S9): `Remember.Everything`, `Remember.AsShown`, `Remember.Sealed` (through a `SealKeyProvider`
   port), `Remember.OutcomeOnly`, with a defined interaction against inbound `onDuplicate`/`onFailure` and saga
   ledger replay.
7. Merge and inheritance rules, explicit `exempt` entries with a reason logged at boot.
8. Regex safety: boot validation against catastrophic backtracking, optional linear engine
   (RE2-compatible port), `maxScanBytes`.
9. A false-positive policy, with match acceptance checks done in code (digit adjacency, Luhn).
10. A fix for the three leaks Estela has today (S3, S11, S12), shipped unconditionally.
11. Testing helpers `captureTrail()` and `expectNoLeak()` with an encoded-forms corpus.
12. **(added)** Flow parameters (section 18): named `profiles`, `PrivacyRef` at every level,
    `FlowOptions.privacy` (flow level), `StepCommonOptions.privacy` and `FlowTarget.privacy`
    (step and target level), the `Reach.Delivery` exception, and graph annotations by name, following
    the shared ESTELA flow parameter model.

### 0.5 Non-goals

- A Koletz pack, Koletz header names or per-channel Koletz configuration (Koletz adoption spec).
- Sinks outside Estela: heap dumps and core files, APM/OpenTelemetry exporters (SPI-437 will route its
  span attributes through this redactor when it exists), Nest's own `ExceptionsHandler` logs, the
  app's own logger calls, HTTP access logs, database query logs. Section 1.3 gives guidance; the
  injectable `PrivacyEngine` exposes `forLog`/`errorForTrail` for them (SD-39).
- Changing what reaches remote services: outbound request bodies, gRPC requests and replies are the
  real message and are never redacted.
- Transforming idempotency **keys** at rest (they are identities; open question Q5).
- Decoding encoded content at run time (base64 blobs, compressed bodies). Encoded leaks are detected by
  `expectNoLeak` in tests, not prevented by the runtime (risk R3).
- Broker-backed channels (SPI-434) and care (SPI-445, `RS-` requirements). No privacy rule depends on
  care; this ticket builds only on the flow parameter scaffolding SPI-445 already shipped (SD-67). It
  adds no retry loop and consumes no retry budget: its errors only carry `retryable` (section 8.1).
- Performance budgets. Overhead is measured and budgets are set in SPI-444 (SD-41).
- Outbound REST `retry`/`timeoutMs`: untouched by this ticket. `OutboundRestOptions` and
  `OutboundRestCallOptions` only gain `privacy`.

## 1. Threat model

### 1.1 Assets and readers

| Asset | Examples (generic) |
|---|---|
| Credentials | API keys, bearer tokens, JWTs, basic-auth userinfo, private keys, provider auth tokens |
| Personal data | phone numbers, emails, card numbers, free text written by end users |
| Correlation material | idempotency keys built from personal data |

Readers the policy defends against: anyone who can read logs (support staff, log vendors, CI
artifacts), anyone who can read the idempotency store or the saga ledger (Redis/Postgres operators,
backups, replicas), subscribers of wire-tap and `error.channel` channels, and test reports. Not in the
model: an attacker with code execution or memory access in the process, or one holding the
`FingerprintSecretProvider`/`SealKeyProvider` secrets.

### 1.2 In scope

Every sink in section 0.3 that Estela writes (S1 to S12) plus test captures (S14). Grouped by the
surfaces the epic names:

| Surface | Sinks |
|---|---|
| Hop and error logs | S1, S2, S3, S5; **(amended)** S15 (SD-66, SHOULD) |
| Message headers and history | headers inside S4 envelopes and S10 copies; `history` holds no payload (0.2) and its fields are protected (SD-10) |
| Error messages built or carried by Estela | S3, S4, S11, S12 |
| Idempotency store | S6, S7, S8 |
| Saga ledger | S9 |
| Wire-tap copies | S10 |
| Test captures | S14 |

### 1.3 Out of scope, with guidance

| Surface | Guidance in the README |
|---|---|
| Nest `ExceptionsHandler` / app exception filters | Inject `PrivacyEngine` and log `privacy.errorForTrail(error)` instead of the error; never echo `error.message` of an upstream error to clients. `InboundIdempotencyInFlightError` reaches this surface (S12) |
| App logger calls | Use `privacy.forLog(value, { channel })` for anything that came from a payload |
| OTel / APM exporters | Do not record payloads as span attributes; SPI-437 will route attributes through the redactor |
| Heap dumps, core files | Treat as secret-bearing; restrict access; never attach to tickets |
| `OutboundHttpError.body/headers/url` read by app code | They stay intact on the thrown error (the app needs them); only sink copies are redacted |
| Idempotency keys as storage keys (Redis key names, Postgres primary keys) | Build keys from opaque ids, never from personal data; key transformation at rest is Q5 |

### 1.4 Hashing: brute force and salt rotation

- **Low-entropy values.** Phone numbers have roughly 10^7 to 10^11 candidates per country; an unsalted
  or leaked-salt hash of a phone number is reversed by enumeration in minutes. Truncating the hash
  does not help. Therefore `Show.Fingerprint` is always an HMAC with a secret salt (SD-15), the salt is a secret
  of the same class as the data, and hashed values in logs are pseudonymous personal data, not
  anonymous data.
- **`Show.Ends` is identifying.** `+502***427` leaves about 10^4 candidates for a known country and
  prefix; with context (time, campaign) it is often unique. This is why customer numbers default to
  `Show.Fingerprint` (D-PHONE).
- **Rotation.** A new salt changes every token: values hashed before and after a rotation do not
  correlate. Tokens carry the secret id (`fp:<secretId>:<hex>`) so a reader can tell a rotation from a
  different value. There is no dual-salt mode: correlation across a rotation is given up on purpose.
- **Salt leak.** Every token written with that salt must be considered reversible for low-entropy
  values; rotate and treat the affected log range as containing personal data.
- **Salt scope.** One salt per environment. Sharing a salt across environments lets a token from a
  lower environment's logs be correlated with production; the README says so.

## 2. Backward-compatibility contract

- **No `privacy` option.** Public APIs, the message delivered to every handler, replies, idempotency
  records, saga ledger rows and wire-tap copies are byte-for-byte as in 0.9.0. Log sinks apply the
  **baseline**: the pinned `secrets@1` pack and `DEFAULT_HIDDEN_HEADERS` (with the idempotency
  key headers hidden, since the baseline has no fingerprint secret), on S1, S2, S3 and S5 only (D3) **(amended)**, plus S15 once SD-66 is implemented. A later
  `secrets@2` never changes the baseline outside a release note.
- **`privacy: false`.** Restores the 0.9.0 log text exactly, except for the three fixes below.
- **Three unconditional fixes** (`fix` commits, not behind an option):
  1. S3 no longer runs `JSON.stringify` on raw error objects. With an engine (baseline or privacy),
     errors are written as `{ name, message, code?, status? }` plus redacted own enumerable
     properties; with `privacy: false` only `{ name, message, code?, status?, url? }` is written.
     Any `url` goes through `urlForTrail` (SD-04).
  2. S11: `restOut` errors print `urlForTrail(options.url)` (SD-05).
  3. S12: `IdempotencyInProgressError.message` becomes `IDEMPOTENCY_KEY_IN_PROGRESS: <scope>`, like
     the inbound error; the `key` property stays for app code (SD-43). No test or README line asserts
     the old text (checked: only the inbound message is asserted, `inbound.adaptable.spec.ts:942`).
- **Additive types only.** Every new member of an existing public type is optional:
  `IntegrationModuleOptions.privacy`, `ChannelSpec.privacy`, `InboundSpec.privacy`,
  `InboundIdempotencyOptions.remember`, `ActivatorOptions.privacy`, `OutboundRestOptions.privacy`,
  `OutboundRestCallOptions.privacy`, `SagaRunnerOptions.privacy`, `IntegrationFlow.wireTap(channel, options?)`, a second optional
  `HopLogger` constructor parameter. No port a consumer implements changes (`IdempotencyStore`,
  `IdempotencyLedger`, `LockPort`, `TransitionPort`, `ChannelFactory`, `InboundTransportStrategy`).
- **Store contract.** Sealed and outcome-only records are plain JSON-safe `Record<string, unknown>`
  values, so `MemoryIdempotencyStore` and existing custom stores (the README Redis contract) work
  unmodified (SD-35).
- The emitted `.d.ts` stays parseable by TypeScript 4.9 (`test/dist-typescript4.spec.ts`).
- Outbound REST `retry`/`timeoutMs`: unchanged; nothing to migrate in this ticket. Their migration to
  the care model belongs to SPI-445 (RS-34).
- **Flow DSL and parameter references (section 18).** **(amended)** SPI-445 already ships the
  optional trailing arguments (`IntegrationFlow.from(source, options?)`, `StepCommonOptions` on the DSL
  steps, `FlowTarget`, `JumpOptions`); this ticket only adds optional members to them
  (`FlowOptions.privacy`, `StepCommonOptions.privacy`, `FlowTarget.privacy`, `JumpOptions.privacy`),
  plus `PrivacyModuleOptions.profiles` and `PrivacyRef` wherever a level accepts privacy rules (a
  `Privacy` object is still a valid `PrivacyRef`). With none of them set, step `describe()` output, the graph snapshot, tap copies and
  delivered messages are as in 0.9.0 (SD-65); the existing describe assertions
  (`src/example/insurance/insurance.spec.ts:61`, `{ kind: 'wireTap', channel }`) keep passing.
- **Migration when a team opts in.** Setting any `privacy` object changes the default `remember`
  of every durable scope it reaches to `Remember.OutcomeOnly` (D5). Visible effects: request/reply endpoints
  with `onDuplicate: 'replay'` fail boot until they choose a `remember` (SD-30), and activator
  duplicates stop re-sending cached replies (SD-34). Boot lists every scope whose `remember` was
  defaulted (SD-29), so the change is seen at deploy time, not at the first duplicate. Recipe in the
  README: start with `remember: Remember.Everything` plus `rememberReason` per scope, then tighten.
  **(amended)** A second visible effect of opting in: wire-tap subscribers whose tap is reached by
  the new policy start to receive redacted copies (SD-52). A tap that must keep the raw payload sets
  `copy: TapCopy.Original` with a `copyReason`. Declaring only `profiles` changes nothing until a level
  references one (SD-57).

## 3. Requirements

RFC 2119 keywords. Every requirement has one acceptance criterion and at least one named test
(section 10). File paths are under `src/` unless stated.

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| SD-01 (amended) | MUST | Without a `privacy` option, behaviour is as in section 2: stores, replies, ledger and delivered messages unchanged; log sinks apply the baseline. `privacy: false` restores 0.9.0 log text except for the three fixes (SD-04, SD-05, SD-43). | G an app on 0.9.0 config; W the inbound, activator, flow and saga suites run; T records and replies deep-equal 0.9.0, and S1/S2/S3/S5 text differs only where a `secrets@1` rule or `DEFAULT_HIDDEN_HEADERS` matched or one of the three fixes applies | `compat: no privacy option keeps records, replies and messages identical`; `compat: privacy false keeps 0.9.0 log text` |
| SD-02 (amended) | MUST | Redaction produces a copy for a sink; it never mutates the input, and the message delivered to activators, flows and remote services and the error thrown to callers are the originals. **(amended)** The only exception is an L4 flow step option `privacy: { reach: Reach.Delivery, reachReason }` (SD-50); no other option changes a delivered value (SD-54). | G a deep-frozen payload with secrets; W every sink writes; T no `TypeError` from frozen writes, the activator receives the same reference, the thrown error keeps its original `message` | `redactor never mutates its input (deep-frozen payload)`; `activator receives the original payload while sinks get redacted copies` |
| SD-03 (amended) | MUST | A policy never disables or suppresses a log line: flow, hop, error, boot and wire-tap output keep firing with redacted content and the same structure (keys, ids, sizes when `Show.Length`). | G `logging.hops: true`, a policy, a flow whose step fails and a saga whose afterCommit callback throws (runner built with a `HopLogger` and `privacy.engine`); W both run; T `flowStart`, `flowEnd ... error`, the error.channel line, the saga `hopStart`/`hopEnd FAIL` and `hopError` lines are all emitted, with the same count as without a policy | `flow, hop and error lines are still emitted with a policy active` |
| SD-04 (amended) | MUST | The default `error.channel` logger never runs `JSON.stringify` on a raw error. With an engine (baseline or privacy) it writes `{ name, message, code?, status? }` plus the redacted own enumerable properties; with `privacy: false` it writes `{ name, message, code?, status?, url? }` only. Any `url` property goes through `urlForTrail`. Non-`Error` thrown values (`{ value }` envelopes) are redacted like payloads. | G no `privacy` option (baseline) and a flow whose outbound fails with `OutboundHttpError` for `https://u:p@h/x?api_key=SECRET1`, response header `set-cookie: SECRET2` and body `{ token: 'SECRET3' }`; W the error reaches error.channel; T the line contains none of `SECRET1..3`, `u:p@` or `?api_key`, and contains `https://h/x` and the status; with `privacy: false` the line holds no `headers` or `body` key | `error.channel logger never prints raw OutboundHttpError url, headers or body`; `error.channel logger with privacy false keeps only name, message, code, status, url` |
| SD-05 (amended) | MUST | `restOut` error messages use `urlForTrail`. | G `restOut` to `https://u:p@h/x?token=SECRET` answering 500; W it throws; T `message` names `https://h/x` and the status, with no query string or userinfo | `restOut error message carries no query string or userinfo` |
| SD-06 (amended) | MUST | `@Private(options?)` marks DTO properties without `reflect-metadata`; metadata is found through the constructor prototype chain (subclasses inherit, may add) and through a global symbol registry, so it is visible across the ESM and CJS copies of the package. | G `class B extends A` with `@Private()` on `A.secret`; W an instance of B is redacted by the CJS build while the decorator ran in the ESM build; T `secret` is masked | `@Private marks fields on instances and subclasses`; `test/dist-identity.spec.ts: @Private metadata crosses ESM and CJS copies` |
| SD-07 (amended) | MUST | `privateFieldsOf(Class, prefix?)` returns the selectors of a decorated class, so plain payloads (JSON, gRPC loader objects) can use DTO marking. | G `@Private()` on `Account.authToken`; W `privateFieldsOf(Account, 'accounts[*]')`; T it returns `[{ path: 'accounts[*].authToken', show: <default> }]` | `privateFieldsOf turns decorator metadata into selectors` |
| SD-08 (amended) | MUST | Selectors support dot paths, `[*]`, `**` (zero or more levels) and quoted keys (`a["x.y"]`), match keys case-insensitively by default (`keyCase: KeyCase.Match` opts out), compile once at boot, and fail boot with `PrivacyConfigError` (finding `INVALID_SELECTOR`) naming the selector and the level when invalid. A bare name (`token`) matches the root key only. | G selectors `accounts[*].authToken`, `**.password`, `a["x.y"]` and `a..b`; W the module boots; T the first three match their fixtures and boot fails on `a..b` with the selector and level in the message | `selector grammar: dots, [*], **, quoted keys, case`; `invalid selector fails boot with level and selector` |
| SD-09 (amended) | MUST | A header denylist, exported as `DEFAULT_HIDDEN_HEADERS` (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-xsrf-token`; case-insensitive; extendable through `headers`, never shrinkable without `exempt`), hides values in every headers object a sink writes: message headers, raw inbound headers, `OutboundHttpError.headers`. The idempotency key (message header `idempotencyKey`, raw headers `idempotency-key` and `x-idempotency-key`) is fingerprinted when a `fingerprintSecret` is configured and hidden otherwise (fingerprint-or-hide, SD-15). | G a message with custom header `authorization: Bearer X` and `idempotencyKey: K` (as the inbound mapper sets it), and a FingerprintSecretProvider; W it passes a `.wireTap('audit', { copy: TapCopy.AsShown })`; T the audit copy has `authorization: [HIDDEN:header]` and `idempotencyKey: fp:<id>:<hex>`; without a FingerprintSecretProvider the key is `[HIDDEN:header]` | `hidden headers are hidden case-insensitively`; `idempotency key header is fingerprinted, or hidden without a fingerprint secret` |
| SD-10 (amended) | MUST | Protected trace fields (`id`, `traceId`, `spanId`, `parentSpanId`, `correlationId`, `causationId`, `timestamp`, `history[*]`) are never pattern-scanned or hidden; a field rule that selects one fails boot (`PROTECTED_TRACE_FIELD`). | G the `personal` pack and a `correlationId` that looks like a 16-digit card; W a hop error line is written; T the correlation id is printed intact; a rule on `headers.traceId` fails boot | `trace fields are never redacted`; `field rule on a protected trace field fails boot` |
| SD-11 | MUST | Pattern rules run after field rules on every string reached in a sink copy, at any depth: payload values, header values, `Error.message`, `Error.stack`, error own properties and the `cause` chain (within the walk limits of SD-22). | G a policy with a test rule, a payload with a nested string, and an error whose message, stack and `cause.message` each hold a token matched by the rule; W a saga afterCommit throws that error with a hop logger (S1) and a flow fails with it (S3); T none of the four occurrences remains in either line | `patterns redact nested strings, messages, stacks and causes` |
| SD-12 (amended) | MUST | Built-in packs `secrets@1` and `personal@1` (section 6.4) are opt-in by name (`Pack.Secrets` (`'secrets'`) means the latest version, `Pack.SecretsV1` (`'secrets@1'`) pins it); an unknown pack or version fails boot (`UNKNOWN_PACK`). A pack may hold field rules (key names) and pattern rules. The library ships no product-specific pack. | G `packs: [Pack.SecretsV1, Pack.Personal]`; W boot; T both compile; `packs: ['acme']` fails boot naming the unknown pack | `pack resolution: pinned, latest, unknown`; `secrets pack positive and negative corpus`; `personal pack positive and negative corpus` |
| SD-13 | MUST | Built-in pack rules use only syntax that a linear (RE2-class) engine accepts: no lookaround, no backreferences. | G each built-in rule; W the RE2-syntax checker runs; T no rule is rejected | `built-in pack rules use RE2-compatible syntax only` |
| SD-14 (amended) | MUST | `Show` values behave as in section 6.3: `Show.Hidden`, `Show.Omitted`, `Show.Ends` (never reveals more than half the value; short values fall back to `Show.Hidden`), `Show.Fingerprint`, `Show.Length`, `Show.Text`; values that need a scalar fall back to `Show.Hidden` on objects and arrays. | G one fixture per `Show` value including a 6-char value under `Show.Ends` and an object under `Show.Fingerprint`; W redacted; T outputs equal the table; the short value and the object are masked | `show values: one case per Show member`; `Show.Ends never reveals more than half and hides short values` |
| SD-15 (amended) | MUST | `Show.Fingerprint` is HMAC-SHA256 keyed by the current fingerprint secret (at least 32 bytes) with output `fp:<secretId>:<hex>` (16 hex chars by default, `fingerprintChars` 12..64). A rule whose `show` a user set to `Show.Fingerprint` explicitly, with no `fingerprintSecret`, fails boot (`FINGERPRINT_WITHOUT_SECRET`), and a secret under 32 bytes fails boot (`FINGERPRINT_SECRET_SHORT`); there is no unsalted hash. Built-in rules (pack rules and the idempotency key header) use fingerprint-or-hide: they hash with a fingerprint secret and mask without one, which is never weaker. | G no `FingerprintSecretProvider`; W boot with a user rule `{ show: Show.Fingerprint }`; T `PrivacyConfigError` names the rule; with a 16-byte fingerprint secret boot also fails; with `packs: [Pack.Personal]` and no fingerprint secret boot passes and phones are masked | `fingerprint requires a fingerprint secret of 32 bytes`; `fingerprint token is a keyed HMAC with the secret id`; `built-in fingerprint-or-hide rules hide without a fingerprint secret` |
| SD-16 (amended) | MUST | The fingerprint secret is read at boot and on `PrivacyEngine.refreshFingerprintSecret()`; a failed refresh keeps the current fingerprint secret and logs one warning without secret material; the fingerprint secret is never printed. | G a provider that fails on refresh; W `refreshFingerprintSecret()` runs; T tokens keep the old secret id and one warn line is logged, containing the secret id only | `failed fingerprint secret refresh keeps the current secret and warns` |
| SD-17 (amended) | MUST | Levels go from outer to inner: module, channel, endpoint/binding/activator/saga, call. Field, header and pattern lists are unions. For the same path the stricter `show` wins (`Show.Omitted` > `Show.Hidden` = `Show.Text` > `Show.Length` > `Show.Fingerprint` > `Show.Ends`); between two values of equal strength the outer level's wins. An inner level cannot remove or weaken an outer rule except through `exempt` (SD-18). **(amended)** The flow DSL adds the flow level (`FlowOptions.privacy`, L3) and the step or target level (L4) inside the channel level, and inbound scopes add `InboundDefaults.privacy` between module and channel; the full order per scope is in 6.6 and 18.2. | G module `Show.Hidden` on `**.token` and endpoint `Show.Ends` on `token`; W the endpoint writes a sink; T `token` is masked; G module `text: 'x'` and channel `Show.Hidden` on the same path; T the output is `x` | `merge: unions, stricter show wins, inner levels cannot weaken, ties keep the outer show` |
| SD-18 (amended) | MUST | `exempt: [{ path, show?, reason }]` weakens or removes an outer rule for one path at one level and the levels inside it; `reason` is required (1..200 chars; missing: `EXEMPT_REASON_MISSING`); every exemption is logged at boot at warn level with level, path, show and reason; an `exempt` entry that matches no outer rule logs a warning. The exempted path's value is written with the entry's `show` (or as it is when `show` is undefined) and pattern rules skip it. | G an endpoint field rule `from` plus `exempt: [{ path: 'from', show: Show.Ends, reason: 'business sender number' }]` under `personal`; W boot, then a payload with `from: '+50212345678'` is written to S3; T one warn line with the four fields, and `from` is shown by `Show.Ends` (`showFirst`/`showLast` of 6.3), not fingerprinted by the pattern; the same entry without reason fails boot | `exemptions need a reason, are logged at boot and win over patterns` |
| SD-19 (amended) | MUST | With the default JavaScript engine, every pattern is validated at boot and rejected when it has nested unbounded quantifiers, a quantified alternation whose branches share a first character, adjacent unbounded quantifiers over overlapping sets, a backreference, the sticky flag, or can match a zero-length string at any position (decided on the parsed pattern, not by probing an empty input); the finding is `UNSAFE_PATTERN`. A pattern without the `g` flag is recompiled with it. | G `(a+)+`, `(a\|ab)*`, `\d+\d+`, `(\w+)\1`, `/x/y`, `a*`, `\b`, `(?=x)`; W boot; T each fails boot with the pattern name and the reason; `/AKIA[0-9A-Z]{16}/` passes | `regex safety rejects catastrophic and zero-length patterns` |
| SD-20 (amended) | MAY | A `RegexEngine` port (for example an adapter over `re2`, injected by the app) compiles every rule; with it the backtracking analysis is skipped and syntax the engine rejects fails boot (`UNSAFE_PATTERN`). Estela does not import `re2`. | G a fake engine that rejects lookbehind; W a user rule with lookbehind is compiled; T boot fails naming the rule | `regex engine port compiles every rule and reports rejects at boot` |
| SD-21 | MUST | A string longer than `maxScanBytes` (UTF-8, default 65536, range 1024..16777216) is cut in the sink copy: the first `maxScanBytes` (rounded down to a code point boundary) are scanned; then the copy drops the run of non-whitespace characters that reaches the cut, and at least the last 512 bytes of the window, and appends `[truncated N bytes]`. A secret straddling the cut is never partially emitted, whatever its length; a window with no whitespace is dropped whole. | G a 70 KiB string where a 2 KiB JWT starts 1 KiB before the 64 KiB mark; W written to S3; T no substring of the JWT longer than 8 chars appears and the marker reports the dropped size; G a 70 KiB base64 blob without whitespace; T the copy is the marker only | `long strings are cut after scanning, dropping the token that reaches the cut` |
| SD-22 | MUST | The walker stops at `maxDepth` (default 32) and `maxNodes` (default 10000) with `[TRUNCATED]`, writes `[Circular]` for cycles, never invokes getters (`[Getter]`) or `toJSON` (except `Date`, written as its ISO string), writes `[Binary len=N]` for `Buffer`/`Uint8Array`/`ArrayBuffer`, and walks `Map`/`Set` as entries/values. | G a payload with a cycle, a getter that throws, an object whose `toJSON` throws, a Buffer holding a secret, a `Date` and depth 40; W redacted; T no throw, no secret, the four placeholders appear and the date is an ISO string | `walker limits: depth, nodes, cycles, getters, toJSON, binary, Map and Set` |
| SD-23 (amended) | MUST | If redaction itself throws, the sink writes `[HIDE_FAILED]` in place of the value, the business path continues, and one error line without data is logged (rate-limited to one per sink per minute). | G a selector compiler bug simulated by a throwing rule; W a sink writes; T the sink holds the placeholder and the flow completes | `redaction failure writes a placeholder, never the raw value` |
| SD-24 (amended) | MUST | False-positive policy. A pattern rule may declare `confirm(match, input, offset)`, run in code after the regex matches; a rejected match is left as-is and the scan resumes after it. `personal.phone-e164` matches `\+[1-9]\d{7,14}` and its `confirm` rejects a match preceded or followed by a digit; `personal.card` confirms only the issuer prefixes and lengths of section 6.4 with a valid Luhn check and no adjacent digit. Context is checked in code, never consumed by the regex, so adjacent values are all matched. Over-masking is accepted; each rule has `skipKeys`; protected trace fields are never scanned (SD-10). | G the strings `1731150000000`, `+05:30`, `+0000`, `+123`, `+5021234567890123456` (19 digits), a fixed list of 18- and 19-digit ids that each lack an issuer prefix or fail Luhn, and `call +50212345678 +50287654321`; W the `personal` pack runs; T only the two numbers in the last string are redacted, both of them | `personal false-positive corpus: timestamps, ids, offsets`; `adjacent phone numbers are both redacted` |
| SD-25 (amended) | MUST | The `personal` E.164 rule uses fingerprint-or-hide (D-PHONE: customer numbers are hashed when a fingerprint secret exists); apps keep `Show.Ends` for their own business/sender numbers through a field rule plus an `exempt` with reason (SD-18). | G `personal` and a FingerprintSecretProvider; W `+50212345678` appears in an error message; T it is written as `fp:<id>:<hex>`; without a FingerprintSecretProvider it is `[HIDDEN:personal.phone-e164]` | `personal phone rule fingerprints by default` |
| SD-26 (amended) | MUST | Hidden tokens name the rule that fired: `[HIDDEN:<rule>]` (`header` for `DEFAULT_HIDDEN_HEADERS` and `headers`, `field` for unnamed field rules). Rule names come from configuration only and match `^[a-z0-9][a-z0-9._-]{0,63}$` (otherwise `RULE_NAME`). | G a rule named `My Rule!`; W boot; T boot fails; a rule `personal.email` produces `[HIDDEN:personal.email]` | `hidden tokens name the rule; invalid names fail boot` |
| SD-27 (amended) | MUST | Sinks S1, S2, S3, S5, S6, S7, S8, S9 (when the saga runner has a policy), S10 (when `copy: TapCopy.AsShown`), S11, S12 and S14 apply the effective policy of their channel/endpoint/binding/activator/saga. **(amended)** S10 also applies it by default when an explicit privacy reaches the tap (SD-52); flow sinks use the flow and step subjects of 18.2 (SD-45). | G every Estela entry and exit wired in one app with a policy, logging at debug; W the leak e2e drives success, failure, duplicate and replay paths; T `expectNoLeak` passes for all secrets in all forms | `test/privacy-leak.e2e.spec.ts: no secret reaches any sink at debug level` |
| SD-28 (amended) | MUST | `wireTap(channel, { copy: TapCopy.AsShown })` delivers a redacted copy (same `id`, copied history); without the option it keeps the 0.9.0 shared-payload copy. **(amended)** That default holds only while no explicit privacy reaches the tap (module, tap channel, flow, step); when one does, the copy is redacted by default and `copy: TapCopy.Original` needs `copyReason` (SD-52). | G a flow with `.wireTap('audit', { copy: TapCopy.AsShown })`; W a message with a token passes; T the audit subscriber sees the mask and the main path sees the token | `wireTap copy AsShown delivers a hidden copy` |
| SD-29 (amended) | MUST | `remember` resolves per durable scope (inbound endpoint, activator, saga): an explicit value wins; otherwise `Remember.Everything` when no explicit `privacy` object reaches the scope (the baseline does not count) and `Remember.OutcomeOnly` when one does (module level included). Sagas only get a policy through `SagaRunnerOptions.privacy` (D7). Flow scopes have no `remember`: their records hold no payload (`{ completed }`/`{ filtered }`), and under a policy their failure records hold the redacted error. Boot logs one warn line per scope whose `remember` was defaulted to `Remember.OutcomeOnly`. **(amended)** Only a resolved reference holding at least one rule counts as an explicit `privacy` object; a module object that declares only `profiles`, providers or limits does not (SD-57). Flow step scopes have no `remember` either (SD-58). | G a module policy, an endpoint and an activator without `remember`; W boot and one request; T the record is outcome-only and boot logged one warn line for each of the two scopes; without the module policy the record is `Remember.Everything` and no line is logged | `remember default: Everything without privacy, OutcomeOnly with one, defaulted scopes listed at boot` |
| SD-30 (amended) | MUST | The interaction matrix in section 8.2 holds; a request/reply inbound with `onDuplicate: 'replay'` whose resolved `remember` is `Remember.OutcomeOnly` fails boot (`OUTCOME_ONLY_REPLAY`), naming the endpoint. | G that endpoint; W boot; T `PrivacyConfigError` with the channel name; with `remember: Remember.Sealed` boot passes | `outcome-only plus replay on request/reply fails boot`; one test per matrix row (section 10.1, group G) |
| SD-31 (amended) | MUST | `Remember.Sealed` seals records with AES-256-GCM (random 96-bit IV, key from `SealKeyProvider`, AAD = `estela:v1:<scope>::<key>`) into `{ estelaSealed: { v: 1, kid, iv, tag, ct } }`; a record that fails authentication (tampered, or copied to another key) raises a non-retryable `SealBrokenError` (`SEAL_BROKEN`) and is never re-run. `Remember.Sealed` without `sealKeys` fails boot (`SEALED_WITHOUT_KEYS`). | G a sealed record moved to another storage key; W a repeat reads it; T `SealBrokenError`, the handler is not called | `sealed records: round trip, tamper, key swap` |
| SD-32 (amended) | MUST | D-REDIS-DOWN applied to keys. For a `Remember.Sealed` scope Estela calls `SealKeyProvider.current()` before it claims the key (inbound `begin`, activator `begin`, before the saga's first unit) and seals with that key; when it fails, nothing is claimed or dispatched and the caller gets a retryable `SealKeyUnavailableError`. When `byId()` throws on a repeat the request fails with the same retryable error and is not re-run; when `byId()` returns `undefined` it fails with a non-retryable `ReplayUnavailableError`. There is no fail-open setting for sealed scopes (D-REDIS-DOWN, D13). | G a SealKeyProvider whose `current()` throws; W a new request with a key arrives; T the handler's channel receives nothing, the error is retryable and the store holds no record for the key | `seal key provider down at claim fails closed before dispatch`; `seal key provider down at replay never re-runs`; `retired seal key gives replay unavailable` |
| SD-33 (amended) | MUST | `SagaRunnerOptions.privacy` sets the ledger `remember`. The seal key is fetched before the first unit (SD-32), so no provider call runs inside a database transaction; sealing runs inside the unit's transaction before `record`. On an outcome-only replay the runner returns `replyOnReplay(ctx)` when given, else throws `ReplayUnavailableError`. | G an outcome-only saga without `replyOnReplay`; W the same key runs twice; T the second run throws it and no step runs; G a sealed saga with a spy SealKeyProvider; T `current()` is called before `transactions.run` and never inside it | `saga ledger: sealed round trip, seal key fetched outside the transaction`; `saga ledger: outcome-only replay` |
| SD-34 (amended) | MUST | An activator duplicate whose record is outcome-only and whose message has a reply channel sends no reply and logs one warn line with the scope (never the key). | G an activator scope with an outcome-only record; W a duplicate with `replyChannel` arrives; T no reply is sent and one warn line names the scope | `activator duplicate on an outcome-only record warns and does not reply` |
| SD-35 (amended) | MUST | The `IdempotencyStore` and `IdempotencyLedger` contracts are unchanged; sealed and outcome-only records survive a store that round-trips records through `JSON.stringify`/`JSON.parse`. | G a JSON-serializing fake store; W sealed and outcome-only records are written and replayed; T replays work | `sealed and outcome-only records survive a JSON store` |
| SD-36 | MUST | Redaction is lazy: no walk, scan or hash runs unless a sink is about to write; with hop logging off and no failure, the redactor is never called. | G a module policy and `logging.hops: false`; W 1000 successful requests on a fire-and-forget endpoint (its records are `{ accepted, id }` and are never encoded, section 7.3); T the redactor spy records zero calls | `redactor is not called when no sink writes` |
| SD-37 (amended) | MUST | Boot validation collects every configuration problem and throws one `PrivacyConfigError` listing them; on success one info line per policy scope summarises it (scope, counts, pack versions, `remember`, fingerprint secret id) with no rule bodies or data. **(amended)** Module and profile problems and every L2..L4 reference problem are reported together by the boot resolver (SD-55), and the error also carries structured `findings`; flow and step subjects get summary lines (SD-60). | G three independent config errors; W boot; T one error lists all three, and it is `instanceof PrivacyError` with `kind: 'config'` | `boot reports all configuration errors at once`; `boot summary line has no data`; `privacy errors carry the PrivacyError brand, kind, code and retryable` |
| SD-38 (amended) | MUST | `@estela/nest/testing` exports `captureTrail()` and `expectNoLeak()` (section 4.9). The corpus checks plain, base64 and base64url at the three byte alignments, `encodeURIComponent`, form encoding, JSON-escaped and double JSON-escaped forms; secrets shorter than 8 chars are refused; a failure names the trail output, the form and a SHA-256 prefix of the secret, never the secret. | G a secret written base64-encoded at offset 1 inside a log line; W `expectNoLeak` runs; T it fails naming output `log`, form `base64@1` and the hash prefix | `expectNoLeak finds every encoded form`; `expectNoLeak never prints the secret` |
| SD-39 (amended) | SHOULD | The module provides `PrivacyEngine` as an injectable provider whose `forLog(value, { channel? })` and `errorForTrail(error, { channel? })` use the compiled module policy, for app code (exception filters, app loggers). There is no process-global engine: two modules in one process keep separate policies. | G an exception filter that injects `PrivacyEngine`, and two test apps with different policies in one process; W an upstream error with a token is caught in each; T each filter's line is masked by its own app's policy | `PrivacyEngine is injectable and scoped to its module` |
| SD-40 | MUST | No runtime dependency is added; `src/sensitive/` imports no npm package (new depcruise rule `sensitive-no-npm`, `node:` modules allowed); the domain files keep their rule; d.ts stays TS 4.9-parseable. | G the build; W `npm run verify`; T depcruise and `dist-typescript4` pass | depcruise `sensitive-no-npm`; `test/dist-typescript4.spec.ts` |
| SD-41 | SHOULD | Overhead is measured, not assumed: a benchmark (payload sizes, rule counts, packs, engines) is added under SPI-444, which sets the budgets. | G SPI-444; W the benchmark runs; T results are published and budgets recorded there | SPI-444 `bench/sensitive.bench.ts` |
| SD-42 (amended) | MUST | Fingerprint secret and seal key material, rule bodies and exempted values are never written to any sink, including boot lines and `PrivacyConfigError` messages. | G a misconfigured 16-byte fingerprint secret; W boot fails; T the error text holds the secret id and length, not the bytes | `config errors and boot lines never print fingerprint secret or seal key material` |
| SD-43 (amended) | MUST | Estela's own errors keep idempotency keys out of `message`: `IdempotencyInProgressError.message` is `IDEMPOTENCY_KEY_IN_PROGRESS: <scope>`. Their key-bearing own properties (`IdempotencyInProgressError.key`, `InboundIdempotencyInFlightError.clientKey`) are written by every sink with the idempotency-key treatment of SD-09 (fingerprint-or-hide), baseline included. | G a saga run from an activator with a key `K-555` whose first run is in progress; W the duplicate throws and reaches error.channel; T `message` and the S3 line hold no `K-555`, and `error.key` on the thrown error is still `K-555` | `in-progress errors keep the key out of message and sinks` |
| SD-44 (amended) | MUST | Inbound endpoints that boot discovery skips (`integration.module.ts:347-350` logs and continues) are validated when their plan is built at the first request: a configuration problem there throws `PrivacyConfigError` for that request, before any claim, and is logged once per endpoint. | G an endpoint whose policy has an invalid selector and whose discovery is made to fail; W its first request arrives; T the request fails with `PrivacyConfigError`, nothing is claimed, and a second request fails the same way with no second log line | `inbound policy missed by discovery is validated at first plan build` |

Requirements SD-45 to SD-67 (flow DSL, profiles, channel and endpoint references, graph and boot
observability) are in section 18.4, with the same columns.

## 4. Public API by file

All new code sits in `src/sensitive/` and imports only `node:crypto` and sibling files. Comments are
English and ASCII-only (`npm run comments:en`).

### 4.1 `sensitive/privacy.types.ts` (new) **(amended)**

```ts
/** How a value is shown in the trail (6.3). Strength: Omitted > Hidden = Text > Length > Fingerprint > Ends. */
export enum Show {
  Hidden = 'hidden',            // default: [HIDDEN:<rule>]
  Omitted = 'omitted',          // key or array element left out
  Ends = 'ends',                // +502***427; Hidden under 8 chars and for objects
  Fingerprint = 'fingerprint',  // fp:<secretId>:<hex>; Hidden for objects
  Length = 'length',            // [HIDDEN:<rule> len=<n>]
  Text = 'text',                // the literal `text`
}

export interface ShowOptions {
  show?: Show;                // default Show.Hidden
  showFirst?: number;         // Show.Ends; default 0
  showLast?: number;          // Show.Ends; default 4
  text?: string;              // Show.Text; literal output
}

export interface FieldRule extends ShowOptions {
  /** Selector (section 6.1). */
  path: string;
  /** Rule name used in hidden tokens; default 'field'. */
  name?: string;
}

export interface PatternRule extends ShowOptions {
  name: string;               // ^[a-z0-9][a-z0-9._-]{0,63}$
  regex: RegExp;
  /** Capture group to hide; default 0 (the whole match). */
  group?: number;
  /** Selectors whose values this rule never scans. */
  skipKeys?: readonly string[];
  /** Runs after a regex match; false leaves the match as it is (context and checksum checks, SD-24). */
  confirm?: (match: string, input: string, offset: number) => boolean;
}

export enum Pack { Secrets = 'secrets', SecretsV1 = 'secrets@1', Personal = 'personal', PersonalV1 = 'personal@1' }
export type PackName = Pack | `secrets@${number}` | `personal@${number}`;

export interface Exemption {
  path: string;
  /** How this path is shown at this level; undefined means the path is shown as it is. */
  show?: Show;
  reason: string;             // 1..200 chars, logged at boot
}

/** What durable scopes keep (8.2). */
export enum Remember {
  Everything = 'everything',  // needs rememberReason under explicit privacy
  AsShown = 'as-shown',
  Sealed = 'sealed',          // needs sealKeys
  OutcomeOnly = 'outcome-only',
}

export enum KeyCase { Ignore = 'ignore', Match = 'match' }

/** Where the rules of a reference apply (SD-50). */
export enum Reach { Trail = 'trail', Delivery = 'delivery' }

/** The rules a channel, endpoint, binding, activator, saga or call declares. */
export interface Privacy {
  fields?: readonly (string | FieldRule)[];   // a string is { path, show: defaultShow }
  headers?: readonly string[];                // added to DEFAULT_HIDDEN_HEADERS
  patterns?: readonly PatternRule[];
  packs?: readonly PackName[];
  exempt?: readonly Exemption[];
  /** Durable scopes only (inbound, activator, saga). */
  remember?: Remember;
  /** Required when remember is Remember.Everything under explicit privacy; logged at boot. */
  rememberReason?: string;
  defaultShow?: Show;                         // default Show.Hidden
  keyCase?: KeyCase;                          // default KeyCase.Ignore
}

/** Module-wide options: `forRoot({ privacy })`. `false` disables the baseline (section 2), L1 only. */
export interface PrivacyModuleOptions extends Privacy {
  fingerprintSecret?: FingerprintSecretProvider;
  fingerprintChars?: number;  // default 16, range 12..64
  sealKeys?: SealKeyProvider;
  regexEngine?: RegexEngine;
  maxScanBytes?: number;      // default 65536 (provisional, revisited in SPI-444)
  maxDepth?: number;          // default 32
  maxNodes?: number;          // default 10000
}

/** The baseline header denylist (SD-09), exported. */
export declare const DEFAULT_HIDDEN_HEADERS: readonly string[];
```

**(amended) Profiles and references (section 18, shared flow parameter model section 2):**

```ts
/** Profile names: ^[a-z0-9][a-z0-9._-]{0,63}$ (the grammar of PatternRule.name). Already exported by SPI-445. */
export type ProfileName = string;

export interface PrivacyProfile extends Privacy {
  extends?: ProfileName | readonly ProfileName[];
}

// PrivacyModuleOptions also has (optional, additive):
//   profiles?: Readonly<Record<ProfileName, PrivacyProfile>>;

/** What L2..L5 accept wherever privacy rules are accepted. */
export type PrivacyRef =
  | ProfileName
  | readonly ProfileName[]
  | (Privacy & {
      use?: ProfileName | readonly ProfileName[];
      /** Reach.Trail (default) | Reach.Delivery (L4 flow steps only, SD-50). */
      reach?: Reach;
      reachReason?: string;          // required with Reach.Delivery, logged at boot
    });
```

### 4.2 `sensitive/private.decorator.ts` (new) **(amended)**

```ts
export function Private(options?: ShowOptions & { name?: string }): PropertyDecorator;
/** Selectors of a decorated class, prefixed (e.g. 'accounts[*]'). Own and inherited fields. */
export function privateFieldsOf(type: abstract new (...args: never[]) => unknown, prefix?: string): FieldRule[];
```

Metadata is kept on the constructor under `Symbol.for('@estela/nest.private')` (non-enumerable),
so two copies of the package share it (the same reason as the saga error brand, D25 of the saga
spec). No `reflect-metadata`.

### 4.3 `sensitive/fingerprint-secret.ts`, `sensitive/seal-key.ts` (new ports) **(amended)**

```ts
export interface FingerprintSecret { id: string; secret: Uint8Array }   // id ^[A-Za-z0-9_-]{1,16}$, secret >= 32 bytes
export interface FingerprintSecretProvider { current(): FingerprintSecret | Promise<FingerprintSecret> }
/** Reads base64 from an env var; id from a second var. Throws at boot when missing or short. */
export function envFingerprintSecret(secretVar: string, idVar: string, env?: Record<string, string | undefined>): FingerprintSecretProvider;

export interface SealKey { id: string; key: Uint8Array }              // 32 bytes (AES-256)
export interface SealKeyProvider {
  /** Key for new records. Implementations cache; Estela calls it once per sealed write. */
  current(): Promise<SealKey>;
  /** Key of an existing record; undefined when retired. */
  byId(id: string): Promise<SealKey | undefined>;
}
```

`SealKeyProvider` implementations SHOULD NOT retry internally; a failure surfaces as the retryable
error of SD-32 and the caller's retry layer decides (SPI-445: RS-17a classifies it `'transient'`,
RS-28 to RS-31 own the budget).

### 4.4 `sensitive/regex-engine.ts` (new port)

```ts
export interface CompiledPattern {
  /** Calls fn for every non-overlapping match, left to right; fn returns the replacement. */
  replaceAll(input: string, fn: (match: string, groups: readonly (string | undefined)[], offset: number) => string): string;
}
export interface RegexEngine { readonly name: string; compile(source: string, flags: string): CompiledPattern }
/** The default engine: native RegExp, guarded by the boot analysis of SD-19. */
export const nativeRegexEngine: RegexEngine;
```

### 4.5 `sensitive/privacy-engine.ts` (new) **(amended)**

```ts
/** The kind of trail place a value is written to. */
export enum TrailOutput {
  Log = 'log', Store = 'store', Ledger = 'ledger', WireTap = 'wiretap',
  ErrorEnvelope = 'error-envelope', Capture = 'capture',
}
export interface TrailContext { output: TrailOutput; channel?: string; scope?: string }
export class PrivacyEngine {
  /** Compiled at module init. (amended) Returns its problems to the boot resolver, which throws
   *  one PrivacyConfigError with every finding (7.1, SD-55). */
  static compile(options: PrivacyModuleOptions | false | undefined, scopes: PrivacyScopes): Promise<PrivacyEngine>;
  forTrail<T>(value: T, ctx: TrailContext): unknown;
  errorForTrail(error: unknown, ctx: TrailContext): { name: string; message: string; stack?: string; [k: string]: unknown };
  textForTrail(text: string, ctx: TrailContext): string;
  /** For app code (SD-39): the module privacy, output TrailOutput.Log. */
  forLog(value: unknown, ctx?: { channel?: string }): unknown;
  rememberOf(scope: string): Remember;
  refreshFingerprintSecret(): Promise<void>;
  /** (amended, SD-61) Counters by rule, trail output and subject; never values. */
  stats(): { byRule: Record<string, number>; byOutput: Record<string, number>; bySubject: Record<string, number>; hideFailed: number; deliveryCopyFailed: number };
}
/** Drops userinfo and the query string (SD-04, SD-05). */
export function urlForTrail(url: string): string;
```

`PrivacyEngine` is a Nest provider of the module (exported like `ChannelRegistry` and `CareEngine`);
there is no process-global instance (SD-39). Its `errorForTrail(error, ctx)` is the same method the
sinks use. `PrivacyScopes` (the per-scope rules the module collects at boot) is internal to the
compile call. Its Nest logger is `Logger('EstelaPrivacy')`.

### 4.6 `sensitive/sealed-record.ts` (new) **(amended)**

```ts
export const SEALED_RECORD_KEY = 'estelaSealed';
export const OUTCOME_ONLY_RECORD_KEY = 'estelaOutcomeOnly';
export interface RecordCodec {
  readonly remember: Remember;
  /** Called before the claim. Remember.Sealed: fetches SealKeyProvider.current() (SD-32); others: no I/O. */
  prepare(): Promise<RecordSealer>;
  /** Inverse on read; Remember.OutcomeOnly yields { outcomeOnly: true }. byId() failures per SD-32. */
  decode(scope: string, key: string, stored: Record<string, unknown>): Promise<Record<string, unknown> | { outcomeOnly: true }>;
}
/** Holds the seal key fetched by prepare(); encode is CPU-only (safe inside a transaction). */
export interface RecordSealer {
  encode(scope: string, key: string, record: Record<string, unknown>): Record<string, unknown>;
}
```

The codec sits above the store, in the inbound gate, the activator wrapper and the saga runner, not in
the store (D13). It does not use a store-level codec: the hook first drafted for SPI-429
(MR-20) is retired in the MR spec (its D17), because that hook is synchronous, does not receive `scope`/`key` (needed for the AAD of SD-31), and
is absent from `MemoryIdempotencyStore` and existing custom stores.

### 4.7 `sensitive/privacy-errors.ts` (new) **(amended)**

```ts
/** Brand Symbol.for('@estela/nest.PrivacyError'); [Symbol.hasInstance] checks it, like CareError,
 *  so instanceof works across the ESM and CJS copies of the package. */
export type PrivacyErrorKind = 'config' | 'seal-key' | 'replay' | 'seal-broken' | 'delivery-copy';
export abstract class PrivacyError extends Error {
  abstract readonly kind: PrivacyErrorKind;
  abstract readonly retryable: boolean;
}
export class PrivacyConfigError extends PrivacyError {
  readonly kind = 'config'; readonly retryable = false;
  readonly problems: readonly string[];
  readonly findings: readonly PrivacyFinding[];       // (amended, section 18)
}
export class SealKeyUnavailableError extends PrivacyError { readonly kind = 'seal-key'; readonly retryable = true; readonly code = 'SEAL_KEY_UNAVAILABLE' }
export class ReplayUnavailableError extends PrivacyError { readonly kind = 'replay'; readonly retryable = false; readonly code = 'REPLAY_UNAVAILABLE' }
export class SealBrokenError extends PrivacyError { readonly kind = 'seal-broken'; readonly retryable = false; readonly code = 'SEAL_BROKEN' }
export class DeliveryCopyError extends PrivacyError { readonly kind = 'delivery-copy'; readonly retryable = false; readonly code = 'DELIVERY_COPY_FAILED' }

export interface PrivacyFinding {
  code: string;               // table below
  severity: 'error' | 'warning';
  subject: string;            // e.g. "flow 'loan' step 'credit'", "channel 'payments.charge'"
  path: string;               // option path, always under privacy, e.g. "privacy.use"
}
// (amended, cross-spec) when concerns mix, each PrivacyFinding is carried in FlowDefinitionError as a
// FlowParameterFinding (RS 3.10) with concern 'privacy' and a names-only message (RS-67, SD-55)
```

Finding codes (every one is an error unless marked):

| Code | Raised when | Requirement |
|---|---|---|
| `UNKNOWN_PROFILE`, `PROFILE_CYCLE`, `PROFILE_DEPTH`, `PROFILE_NAME` | profile reference problems (shared codes) | SD-48, SD-56, SD-63 |
| `DUPLICATE_STEP_ID` | two steps of one flow share an id (shared code, concern `flow`) | RS-57 |
| `PRIVACY_FALSE_BELOW_MODULE` | `privacy: false` below L1 | SD-49 |
| `PRIVACY_OFF_WITH_REFS` | `forRoot({ privacy: false })` with lower references | SD-49 |
| `DELIVERY_REACH_LEVEL` | `Reach.Delivery` at L1..L3, on `filter`, `wireTap`, `route` or `reply`, or without `reachReason` | SD-50 |
| `REMEMBER_LEVEL` | `remember` at L3 or on a flow step or target | SD-58 |
| `EXEMPT_REASON_MISSING` | an `exempt` entry without a 1..200 char `reason` | SD-18 |
| `REMEMBER_REASON_MISSING` | `Remember.Everything` under explicit privacy without `rememberReason` | 6.6, SD-29 |
| `COPY_REASON_MISSING` | `copy: TapCopy.Original` under explicit privacy without `copyReason` | SD-52 |
| `FINGERPRINT_WITHOUT_SECRET` | a user rule with `show: Show.Fingerprint` and no `fingerprintSecret` | SD-15 |
| `FINGERPRINT_SECRET_SHORT` | a fingerprint secret under 32 bytes, or a bad secret id | SD-15, SD-42 |
| `SEALED_WITHOUT_KEYS` | `Remember.Sealed` resolved and no `sealKeys` | SD-31 |
| `OUTCOME_ONLY_REPLAY` | request/reply inbound with `onDuplicate: 'replay'` and `Remember.OutcomeOnly` | SD-30 |
| `INVALID_SELECTOR` | a selector that does not parse | SD-08 |
| `PROTECTED_TRACE_FIELD` | a field rule on a protected trace field | SD-10 |
| `UNKNOWN_PACK` | an unknown pack name or version | SD-12 |
| `RULE_NAME` | a rule name outside `^[a-z0-9][a-z0-9._-]{0,63}$` | SD-26 |
| `UNSAFE_PATTERN` | a pattern the regex analysis or the injected engine rejects | SD-19, SD-20 |

Messages hold scope and channel names only, never keys or values. `SealKeyUnavailableError` is
raised before any claim (SD-32), so there is no key to release; it never reaches the `onFailure`
policy. Errors carry `retryable` for the caller's retry layer; no Estela layer retries them.

### 4.8 Changed files (all additive) **(amended)**

SPI-445 already ships the flow parameter scaffolding (SD-67): `FlowOptions`, `StepCommonOptions`
(`id`), `CareStepOptions`, `JumpOptions`, `WireTapOptions`, `FlowTarget`/`FlowDest` and `StepParams`
in `flow/flow-step.ts` and `flow/integration-flow.ts`, `FlowParameterFinding` in
`resilience/resilience.errors.ts`, `FlowDefinitionError` in `flow/flow-definition-error.ts` and the
care-only `FlowParameterResolver` in `flow/flow-parameter-resolver.ts`. The rows below that touch
those files add privacy members; they do not re-create the types.

| File | Change |
|---|---|
| `integration.module.ts` | `IntegrationModuleOptions.privacy?: PrivacyModuleOptions \| false`; compiles `PrivacyEngine` in `onModuleInit` before channels; error.channel logger uses `errorForTrail`/`forTrail` (SD-04); explorer `onError` uses `textForTrail`; provides and exports `PrivacyEngine` (SD-39) |
| `trace/hop-logger.ts` | `constructor(level?, privacy?: PrivacyEngine)`; `hopError` writes redacted name, message and stack (its only caller is `SagaTracer.error`; the module passes the engine to the hop logger it builds, `integration.module.ts:101-104`; a saga runner gets the engine through `SagaRunnerOptions.privacy.engine`) |
| `saga/saga-tracer.ts` | fallback line redacted through the runner's engine |
| `channel-factory.ts` | `ChannelSpec.privacy?: PrivacyRef` |
| `inbound/inbound.types.ts` | `InboundSpec.privacy?: PrivacyRef`; `InboundIdempotencyOptions.remember?: Remember`; the new `InboundDefaults.privacy?: PrivacyRef` |
| `inbound/inbound.idempotency.ts` | `InboundIdempotencyPlan.codec` gains `records: RecordCodec`; `claim` calls `prepare()`; `succeed`/`settle` encode; repeats decode (section 7.3) |
| `inbound/inbound.failure.ts` | internal `outcomeOnlyFailure(serialized)` keeps `{ kind, status }` or `{ kind, name }`; `clientKey` of `InboundIdempotencyInFlightError` declared key-bearing (SD-43) |
| `saga/idempotency-ledger.ts` | `IdempotencyInProgressError.message` without the key; `key` declared key-bearing (SD-43) |
| `decorators.ts` | `ActivatorOptions.privacy?: PrivacyRef` |
| `activator/activator-wrapper.ts` | records through `RecordCodec`; SD-34 warning |
| `flow/flow-executor.ts` | stored failure redacted; error envelope `error` redacted when privacy applies (raw only with `privacy: false`); the error envelope and the stored failure use the privacy of the failing step's subject (SD-45) |
| `flow/integration-flow.ts`, `flow/steps/wire-tap.step.ts` | `WireTapOptions` (today `StepCommonOptions`) becomes `StepCommonOptions & { copy?: TapCopy; copyReason?: string }`; `export enum TapCopy { AsShown = 'as-shown', Original = 'original' }`; `FlowOptions` (from SPI-445) gains `privacy?: PrivacyRef`; `reply` keeps `id` only (section 18.3) |
| `flow/flow-step.ts`, `flow/steps/*.ts` | `StepCommonOptions`, `FlowTarget` and `JumpOptions` (from SPI-445) gain `privacy?: PrivacyRef`; `StepParams` gains the step and target privacy references; steps keep their resolved plan; `describe()` adds the `privacy` key only when set (SD-59, SD-65) and the `id` key by the rule of RS-66 shared by the three specs (Q17) |
| `flow/flow-parameter-resolver.ts` | the care-only resolver of SPI-445 gains the privacy pass (SD-55): it resolves every L2..L4 `PrivacyRef`, maps each `PrivacyFinding` to a `FlowParameterFinding` with `concern: 'privacy'`, and applies the class rule of RS-67 |
| `resilience/resilience.errors.ts` | `FlowParameterFinding.concern` member `'sensitive'` becomes `'privacy'` (unreleased: SPI-445 is not on `main` yet) |
| `graph/channel-graph.ts` | `privacy?: string[]` on `GraphNode`, `GraphInboundRef`, `GraphOutboundRef`, `GraphFlowEntry.options` and step dests; `privacyProfiles` in `GraphSnapshot.module` (next to `careProfiles`) when declared (SD-59) |
| `adapters/grpc.adapter.ts` | `bindGrpcOut(..., options?: { replyChannel?; id?; care?; privacy?: PrivacyRef })` (shape only; engine wired by SPI-430) |
| `outbound/outbound.types.ts` | `OutboundRestOptions.privacy?: PrivacyRef` (module defaults and bindings) and `OutboundRestCallOptions.privacy?: PrivacyRef` (call level); call-level names validated at first call (SD-56) |
| `adapters/rest.adapter.ts` | message uses `urlForTrail` (SD-05) |
| `saga/saga-runner.ts` | `SagaRunnerOptions.privacy?: { rules?: PrivacyRef; remember?: Remember; sealKeys?: SealKeyProvider; engine?: PrivacyEngine; replyOnReplay?: (ctx: unknown) => unknown }`; names in `rules` resolve only with `engine` (SD-63) |
| `index.ts` | exports the new public symbols, enums as values (`Show`, `Remember`, `KeyCase`, `Reach`, `TapCopy`, `Pack`, `TrailOutput`) (no npm imports added) |

### 4.9 Testing subpath (`src/testing/`) **(amended)**

```ts
export interface TrailWrite { output: TrailOutput; where: string; text: string }
export interface TrailCapture {
  readonly writes: readonly TrailWrite[];
  /** Nest LoggerService to pass to Logger.overrideLogger / app.useLogger. */
  readonly logger: LoggerService;
  store(inner: IdempotencyStore): IdempotencyStore;          // records what is written
  ledger<Tx>(inner: IdempotencyLedger<Tx>): IdempotencyLedger<Tx>;
  channel(registry: ChannelRegistry, name: string): Unsubscribe;
  /** Test-only: also record the values before hiding; expectNoLeak refuses such a capture. */
  readonly keepOriginals: boolean;
}
export function captureTrail(options?: { keepOriginals?: boolean }): TrailCapture;
export function expectNoLeak(capture: TrailCapture, secrets: readonly string[], options?: { forms?: readonly LeakForm[] }): void;
export enum LeakForm {
  AsIs = 'as-is', Base64At0 = 'base64@0', Base64At1 = 'base64@1', Base64At2 = 'base64@2',
  Base64UrlAt0 = 'base64url@0', Base64UrlAt1 = 'base64url@1', Base64UrlAt2 = 'base64url@2',
  Uri = 'uri', Form = 'form', Json = 'json', Json2 = 'json2',
}
export function leakForms(secret: string): ReadonlyMap<LeakForm, string>;
```

`src/testing/` keeps its depcruise rule (no import from `src/inbound/` or `src/adapters/`).

## 5. File layout **(amended)**

The folder stays `src/sensitive/` (as D34 of the resilience spec kept `src/resilience/`); only
`index.ts` exports are public, so internal file and helper names may be plain engineering names.

```
src/sensitive/privacy.types.ts        Show, ShowOptions, rules, Pack, Exemption, Remember, KeyCase,
                                      Reach, Privacy, PrivacyProfile, PrivacyRef, PrivacyModuleOptions,
                                      DEFAULT_HIDDEN_HEADERS
src/sensitive/private.decorator.ts    @Private, privateFieldsOf (global-symbol metadata)
src/sensitive/selector.ts             parse + compile selectors (section 6.1; compileSelector)
src/sensitive/policy-resolver.ts      levels, merge, exempt, remember resolution, boot validation
                                      (resolvePlan, FrozenPlan)
src/sensitive/packs.ts                secrets@1, personal@1
src/sensitive/regex-safety.ts         boot analysis (SD-19, analyzeRegex), RE2-syntax checker (SD-13)
src/sensitive/regex-engine.ts         RegexEngine port, nativeRegexEngine
src/sensitive/masking.ts              Show values, HMAC helper, Luhn and adjacent-digit checks
src/sensitive/privacy-engine.ts       PrivacyEngine, TrailOutput, TrailContext, urlForTrail, walker
                                      (walk, cloneOnWrite), limits
src/sensitive/sealed-record.ts        RecordCodec for each Remember value; AES-GCM helper (seal/open)
src/sensitive/fingerprint-secret.ts   FingerprintSecret, FingerprintSecretProvider, envFingerprintSecret
src/sensitive/seal-key.ts             SealKey, SealKeyProvider
src/sensitive/privacy-errors.ts       PrivacyError family, PrivacyFinding, finding codes
src/sensitive/**/*.spec.ts
src/testing/capture-trail.ts, expect-no-leak.ts, leak-forms.ts (+ testing/index.ts exports)
test/privacy-leak.e2e.spec.ts         HTTP loopback app, every sink, debug level
test/dist-identity.spec.ts            (extended) decorator metadata across ESM/CJS (skipped until built)
docs/ESTELA_SENSITIVE_DATA_SPEC.md    this file
```

Repo rules: eslint `complexity` 12 and cognitive complexity 15 (the walker is split per value kind);
new depcruise rule `sensitive-no-npm` (`^src/sensitive/` may import only `node:` modules and siblings);
no new runtime or peer dependency; `re2` is never imported by Estela. Because of that rule,
`src/sensitive/` never imports `FlowParameterFinding` from `src/resilience/`: the mapping from
`PrivacyFinding` to `FlowParameterFinding` lives in `src/flow/flow-parameter-resolver.ts`.

## 6. Behaviour

### 6.1 Selector grammar

```
selector := segment ('.' segment | '[*]' | '["' key '"]')*
segment  := '**' | '*' | key
```

- `*` matches one key, `[*]` every array element, `**` zero or more levels (objects and arrays).
- Keys compare case-insensitively unless `keyCase: KeyCase.Match`; header names always compare
  case-insensitively.
- A bare name matches the root key only (`token` is not `**.token`).
- Compiled into a trie once at boot; matching is O(path depth x rules at that node).

### 6.2 Order of application for one sink copy

1. Walk limits (SD-22) and protected trace fields (SD-10) are set.
2. Field rules (decorator metadata of class instances, selectors, `DEFAULT_HIDDEN_HEADERS` plus
   `headers`) replace matched values by their `show`.
3. Pattern rules scan every remaining string (after the `maxScanBytes` cut, SD-21), skipping
   `skipKeys`, exempted paths (SD-18) and protected fields; a match is replaced only when the
   rule's `confirm` returns true (SD-24).
4. Unchanged subtrees are shared with the input (copy-on-write); changed nodes are new objects.

### 6.3 How a value is shown (`Show`) **(amended)**

| `Show` | Scalar output | Object/array | Notes |
|---|---|---|---|
| `Show.Hidden` (default) | `[HIDDEN:<rule>]` | same token | |
| `Show.Omitted` | key omitted; array element omitted | same | |
| `Show.Ends` | `+502***427` (`showFirst`, `***`, `showLast`) | falls back to `Show.Hidden` | if `showFirst + showLast > floor(len / 2)` both shrink to fit; values under 8 chars are `Show.Hidden` |
| `Show.Fingerprint` | `fp:<secretId>:<hex>` | falls back to `Show.Hidden` | HMAC-SHA256(fingerprint secret, UTF-8 value), first `fingerprintChars` hex. Built-in rules use fingerprint-or-hide: `Show.Hidden` when no fingerprint secret is configured (SD-15) |
| `Show.Length` | `[HIDDEN:<rule> len=<n>]` | `[HIDDEN:<rule> len=<entries>]` | n in UTF-16 code units |
| `Show.Text` | the literal `text` string | same | |

Numbers and bigints are stringified before `Show.Ends`/`Show.Fingerprint`/`Show.Length`. Strength,
strictest first: `Show.Omitted` > `Show.Hidden` = `Show.Text` > `Show.Length` > `Show.Fingerprint` >
`Show.Ends` (SD-17). Tokens: `[HIDDEN:<rule>]`, bare `[HIDDEN]`, `[HIDE_FAILED]` (SD-23) and the
unchanged walker placeholders `[TRUNCATED]`, `[truncated N bytes]`, `[Circular]`, `[Getter]`,
`[Binary len=N]` (SD-21, SD-22).

### 6.4 Built-in packs (version 1)

All rules use only RE2-compatible syntax (SD-13); context characters are captured and kept through
`group`.

| Pack | Rule | Matches | `Show` |
|---|---|---|---|
| `secrets@1` | `secrets.keys` (field rules) | values of keys named `password`, `passwd`, `secret`, `token`, `access_token`/`accessToken`, `refresh_token`/`refreshToken`, `api_key`/`apiKey`/`api-key`, `client_secret`/`clientSecret`, `private_key`/`privateKey`, `authorization`, at any depth (`**.`), case-insensitive | `Hidden` |
| | `secrets.jwt` | `eyJ` header, `.`, `eyJ` payload, `.`, signature (base64url) | `Hidden` |
| | `secrets.bearer` | `Bearer <token>` (case-insensitive scheme) | `Hidden` (group: token) |
| | `secrets.basic-url` | userinfo in `scheme://user:pass@` | `Hidden` (group: userinfo) |
| | `secrets.aws-key-id` | `AKIA`/`ASIA` + 16 upper alphanumerics | `Hidden` |
| | `secrets.query` | value of `api_key`, `apikey`, `api-key`, `access_token`, `token`, `secret`, `password`, `sig`, `signature` query/form parameters | `Hidden` (group: value) |
| | `secrets.assignment` | `password`/`passwd`/`secret`/`api_key`/`token` followed by `:` or `=` and a value of 4+ chars, in free text and serialized JSON | `Hidden` (group: value) |
| | `secrets.pem` | PEM `PRIVATE KEY` block, terminated or running to the end of the scanned window | `Hidden` |
| `personal@1` | `personal.email` | RFC 5322 subset, linear form | fingerprint-or-hide |
| | `personal.phone-e164` | regex `\+[1-9]\d{7,14}`; `confirm` rejects a digit right before or after the match | fingerprint-or-hide (D-PHONE) |
| | `personal.card` | digit groups (spaces or dashes allowed) whose digits form Visa (`4`, 13/16/19), Mastercard (`51`-`55`, `2221`-`2720`, 16), Amex (`34`, `37`, 15) or Discover (`6011`, `644`-`649`, `65`, 16/19); `confirm` checks prefix, length, Luhn and no adjacent digit. Maestro and UATP are left out on purpose (their prefixes and lengths overlap common numeric ids) | `Ends`, `showLast: 4` |

Known false negatives (risk R1): phone numbers written with spaces, dashes or parentheses, or without
the leading `+`, are not matched by `personal.phone-e164`; field marking is the control for them.

Changing a rule in a way that changes what it matches bumps the pack version (`secrets@2`); `Pack.Secrets`
(`'secrets'`) follows the latest version of the installed release. The baseline (D3) is pinned to `secrets@1`.

### 6.5 Regex safety analysis (JavaScript engine)

The analyzer parses the pattern source into a small AST (groups, alternation, classes, escapes,
quantifiers) and rejects, with the reason in `PrivacyConfigError`:

1. star height above 1: an unbounded quantifier (`*`, `+`, `{n,}`) applied to a group containing
   another unbounded quantifier (`(a+)+`, `(\w+\s?)*`);
2. a quantified alternation whose branches have intersecting first-character sets (`(a|ab)*`);
3. two adjacent unbounded quantifiers over intersecting sets (`\d+\d+`, `\s*\s*`), polynomial;
4. backreferences (`\1`, `\k<n>`);
5. the sticky flag; and any pattern that can match a zero-length string at some position, decided
   on the AST (a node is nullable when it is a `*`/`?`/`{0,n}` quantifier, an anchor, a word
   boundary, a lookaround, or a sequence/alternation of nullable nodes), not by probing `''`.

The check is conservative: it may reject a safe pattern. The remedy is to rewrite it or to inject a
linear engine (SD-20); there is no per-pattern bypass with the native engine (D9, Q3).

### 6.6 Policy resolution

Scopes and their levels:

| Durable or logging scope | Levels merged (lowest to highest precedence) |
|---|---|
| inbound endpoint `inbound:<channel>` | module, channel, `InboundSpec.privacy` **(amended)**: module, `InboundDefaults.privacy` (part of L1), channel, `InboundSpec.privacy` |
| activator `activator:<Class>.<method>` | module, channel, `ActivatorOptions.privacy` |
| flow `flow:<name>` | module, source channel **(amended)**: module, source channel, `FlowOptions.privacy` (L3), then the failing step's subject levels (L4 step and target, plus the destination channel of a send step) for the error envelope and the stored failure (SD-45) |
| flow step `flow:<name>#<stepId>` **(new)** | module, source channel, destination channel (send steps only, SD-45), flow, step `privacy`, target `privacy` (fanout and jump targets) |
| wire-tap copy **(new)** | module, tap channel, source channel, flow, step (SD-52) |
| `headers.jumpReplies[<ch>]` in any sink copy **(new)** | the writing subject's levels, plus channel `<ch>` and that jump target's `privacy` (SD-53) |
| outbound REST binding / call | module, channel (if bound), binding (`OutboundRestOptions.privacy`, module defaults first), call (`OutboundRestCallOptions.privacy`) |
| saga | `SagaRunnerOptions.privacy.rules` (plus the engine's module privacy when `engine` is passed) |
| hop line of a channel | module, channel |

Merge (SD-17): the table lists levels from outer (first) to inner (last). Unions of fields,
headers, patterns and packs; per path the stricter `show` wins, ties keep the outer level's `show`;
`exempt` at a level applies to that level and the levels inside it and is the only way to weaken. `remember` is
taken from the most specific level that sets it, then SD-29. Setting `remember: Remember.Everything` on a
scope that has an effective policy requires `rememberReason` (1..200 chars) in the same object; it
is logged at boot like an exemption, and its absence fails boot (`REMEMBER_REASON_MISSING`).

## 7. Algorithms

### 7.1 Boot (`IntegrationRuntime.onModuleInit`, before channels are created)

```text
compile(options, scopes):
  if options === false: engine = disabled (0.9.0 log text, SD-04/05 still apply)
  problems = []
  secret = options.fingerprintSecret ? await options.fingerprintSecret.current() : undefined   // validate id, >= 32 bytes
  regex  = options.regexEngine ?? nativeRegexEngine
  for each scope (module, channels, endpoints, bindings, activators):
    parse selectors (SD-08), resolve packs (SD-12), validate names (SD-26)
    for each pattern: regex === native ? analyze (SD-19) : regex.compile (SD-20)
    reject explicit Show.Fingerprint without a secret (SD-15), Remember.Sealed without sealKeys,
    Remember.OutcomeOnly + replay on request/reply (SD-30), exempt without reason (SD-18),
    rules on protected fields (SD-10)
    built-in fingerprint-or-hide rules resolve to Show.Fingerprint (secret) or Show.Hidden (none)
  if problems: throw PrivacyConfigError(problems)      // SD-37, no material printed (SD-42)
  log one summary line per scope; one warn line per exemption and per defaulted
  outcome-only scope (SD-29)
```

**(amended)** `compile` still runs before channels are created but no longer throws on its own: it hands its problems to the boot
`FlowParameterResolver` (shared flow parameter model 5.2; shipped care-only by SPI-445, this ticket
adds the privacy pass, SD-67), which runs in `onModuleInit` after channels
are created (step 1, `integration.module.ts:248-258`) and before activators subscribe (step 2,
`:260-263`) and flows attach (step 3, `:265-281`). Because activator discovery (`:261`) and inbound discovery (`:262`) run in step 2 today, the resolver runs both discovery scans itself (the same `DiscoveryService` sources) before step 2, so activator and `InboundSpec` references are resolved before any subscription. It resolves every L2..L4 `PrivacyRef`, freezes one
plan per subject, and throws one `PrivacyConfigError` holding every privacy finding (SD-55), or the
RS-67 class when findings of other concerns are present.
Running it before step 2 matters for this spec: activator references (`ActivatorOptions.privacy`)
must be resolved before the first activator subscribes, so when it throws no activator or flow is
subscribed.

Inbound endpoints are found by the boot discovery (`integration.module.ts:347-360`). An endpoint that
discovery skipped is compiled when the planner first builds its plan (`inbound/inbound.plan.ts:273-282`)
and fails that request with `PrivacyConfigError` (SD-44).

### 7.2 Sink write

```text
write(sink, value, ctx):
  if engine disabled or sink not enabled: write as 0.9.0 (or skip); return     // SD-36
  try: copy = engine.forTrail(value, ctx)   // 6.2
  catch: copy = '[HIDE_FAILED]'; rateLimitedError(sink)                   // SD-23
  sink.write(copy)
```

### 7.3 Durable records (inbound gate, activator, saga ledger)

```text
claim:    sealer = await records.prepare()  // Sealed: SealKeyProvider.current(); throws -> SD-32
                                              // (nothing claimed yet, retryable, no dispatch)
          begin(...) as today
succeed:  stored = sealer.encode(scope, key, record)   // Everything: record; AsShown: forTrail(record);
          store.complete(scope, key, stored)           // Sealed: seal; OutcomeOnly: marker + ids
                                                       // a throw here = today's failing complete
repeat:   raw = store.get(...); rec = await records.decode(...)   // byId failure -> SD-32
          rec.outcomeOnly ? section 8.2 row : today's completedRepeat(rec)
failed:   keep    -> store.fail(scope, key, errorForTrail(error))     (Everything: raw error, as today)
          store   -> encode(wrapStoredFailure(codecFor(remember).serialize(error)))
          release -> as today
```

`{ accepted: true, id }` records hold only a generated message id and are stored as they are for every `remember` value.
`fail` (the `keep` row) receives an `Error` whose `name` and `message` are the redacted ones (outcome-only:
`name`, with `message` set to `code` or empty), never the plain object `errorForTrail` returns, so the
`serializeError` floor of the shipped SPI-429 stores (MR-08) stores `{ name, message }` and never wraps the
copy in `{ value }`.
The saga runner calls `prepare()` once per `run()`, before the first unit, and seals inside the
unit's transaction with the returned sealer (SD-33). Flow scopes have no codec: under a policy
`flow-executor.ts:80` writes `errorForTrail(error)` instead of the raw error (SD-29).

### 7.4 Invariants (each has a unit test)

- **I1.** The input of a redaction is never mutated; delivered messages and thrown errors are the
  originals (SD-02).
- **I2.** No sink receives a value that skipped redaction while a policy or the baseline is active:
  every write goes through `PrivacyEngine` or the disabled path (SD-23, SD-27). **(amended)** The
  documented exceptions are a tap reached by no explicit privacy without `copy: TapCopy.AsShown` (SD-28) and
  a tap with `copy: TapCopy.Original` plus a logged `copyReason` (SD-52).
- **I3.** A sealed record decrypts only under its own `scope::key` (AAD) and key id (SD-31).
- **I4.** A repeat never re-runs the handler because of a privacy failure (decrypt, key, outcome-only)
  (SD-31, SD-32, SD-33).
- **I5.** An inner level never weakens an outer rule except through a logged `exempt` (SD-17, SD-18).
- **I6.** Hashing never runs without a fingerprint secret of at least 32 bytes (SD-15).
- **I7.** Protected trace fields are byte-identical in every sink (SD-10).
- **I8.** Boot fails on any invalid security configuration; there is no warn-and-continue (SD-37).
  The one exception is an inbound endpoint that discovery skipped: it fails its requests instead
  (SD-44).
- **I9.** No provider I/O (`SealKeyProvider`, `FingerprintSecretProvider`) runs inside a saga unit's transaction (SD-33).

## 8. Failure and interaction matrix

### 8.1 Failures

| Situation | Behaviour | Retryable | Requirement |
|---|---|---|---|
| Invalid selector, pack, rule name, unsafe regex, empty-matching regex | boot fails, all problems listed (`INVALID_SELECTOR`, `UNKNOWN_PACK`, `RULE_NAME`, `UNSAFE_PATTERN`) | n/a | SD-08, SD-12, SD-19, SD-26, SD-37 |
| explicit `Show.Fingerprint` rule, no `fingerprintSecret`; any fingerprint secret under 32 bytes | boot fails (`FINGERPRINT_WITHOUT_SECRET`, `FINGERPRINT_SECRET_SHORT`) | n/a | SD-15 |
| built-in fingerprint-or-hide rule, no `fingerprintSecret` | `Show.Hidden` instead of `Show.Fingerprint` | n/a | SD-15 |
| `Remember.Sealed` resolved, no `sealKeys` | boot fails (`SEALED_WITHOUT_KEYS`) | n/a | SD-31 |
| `Remember.OutcomeOnly` + request/reply + `onDuplicate: 'replay'` | boot fails (`OUTCOME_ONLY_REPLAY`) | n/a | SD-30 |
| `remember: Remember.Everything` under explicit privacy without `rememberReason`; `exempt` without reason | boot fails (`REMEMBER_REASON_MISSING`, `EXEMPT_REASON_MISSING`) | n/a | SD-18, SD-29 |
| `FingerprintSecretProvider` fails at boot | boot fails | n/a | SD-15 |
| `FingerprintSecretProvider` fails on `refreshFingerprintSecret()` | keep current fingerprint secret, one warn | n/a | SD-16 |
| `SealKeyProvider.current()` fails before the claim | nothing claimed, no dispatch; `SealKeyUnavailableError` | yes | SD-32 |
| sealing throws at `succeed` (the key was fetched before the claim, so no provider I/O happens here) | as today's failing `complete` (`inbound.idempotency.ts:231-240`): `fail` is written with the redacted error, the key stays blocked until TTL, the error reaches the caller | yes, with the same key (the work ran) | SD-32 |
| `byId()` throws on repeat | `SealKeyUnavailableError`, no re-run | yes | SD-32 |
| `byId()` returns undefined (retired key) | `ReplayUnavailableError`, no re-run | no | SD-32 |
| sealed record fails authentication | `SealBrokenError`, no re-run | no | SD-31 |
| redactor throws | `[HIDE_FAILED]`, flow continues | n/a | SD-23 |
| string above `maxScanBytes` | cut with tail guard | n/a | SD-21 |
| inbound endpoint skipped by discovery has an invalid policy | that request fails with `PrivacyConfigError` before the claim | no | SD-44 |
| idempotency store (Redis) unavailable | unchanged by this ticket: SPI-429 owns it (D-REDIS-DOWN: `IdempotencyStoreUnavailableError`, always fail-closed for `ChannelSpec.sideEffects: true`, configurable with fail-closed default otherwise); `remember` adds no fallback and `prepare()` runs before `begin`, so a key-provider failure and a store failure never both happen on one claim | per SPI-429 | n/a |

This ticket adds no retry loop and reads or spends no retry budget. Retryable errors carry
`retryable: true`; SPI-445 decides which layer retries (RS-17a, RS-28) and how the budget propagates
(RS-29 to RS-31).
`SealKeyProvider` and `FingerprintSecretProvider` implementations SHOULD NOT retry internally (4.3), so a caller's
retry is the only one.

### 8.2 `remember` against inbound idempotency and saga replay

| remember | Record on request/reply success | Repeat, `onDuplicate: 'envelope'` (`result` field) | Repeat, `onDuplicate: 'replay'` | `onFailure: 'store'` | `onFailure: 'keep'` (`fail` record) | Activator duplicate | Saga ledger replay |
|---|---|---|---|---|---|---|---|
| `Remember.Everything` | `{ cachedResult }` as today | cached result (today, `inbound.idempotency.ts:183`) | reply as the first time | codec output as today | raw error as today | re-sends cached result | stored reply |
| `Remember.AsShown` | `{ cachedResult: forTrail(result) }` | redacted result | redacted reply (explicit opt-in only, never a default: replaying `[HIDDEN]` as data is silent corruption, D6) | serialized, then redacted | redacted serialized error | re-sends redacted result | redacted reply |
| `Remember.Sealed` | sealed `{ cachedResult }` | decrypted result | decrypted reply | sealed serialized failure; replay rethrows the original status and body | redacted serialized error (failed records are never replayed) | decrypts and re-sends | decrypted inside the claim transaction |
| `Remember.OutcomeOnly` | `{ estelaOutcomeOnly: { v: 1 } }` | `result: null` | request/reply: boot error (SD-30); fire-and-forget: accepted replay works (ids only) | `{ kind: 'http', status }` or `{ kind: 'error', name }`; replay rethrows the status with a generic body | `{ name, code? }` | no reply, warn (SD-34) | `replyOnReplay(ctx)` or `ReplayUnavailableError` (SD-33) |
| any | `{ accepted: true, id }` for fire-and-forget, unchanged | | | | | | |

`onFailure: 'release'` writes nothing for any `remember` value. `onInFlight` is unaffected (no body is read).
Flow scopes are not in this table: they have no `remember` (SD-29).

## 9. Non-functional requirements

- **Dependencies:** none added (SD-40). `node:crypto` only.
- **Performance:** measured in SPI-444 (SD-41). Structural guarantees here: compile once at boot,
  lazy (SD-36), bounded scan and walk (SD-21, SD-22), no work on hop start/end lines (they carry no
  payload).
- **Memory:** compiled rules are immutable and shared; copy-on-write output.
- **Operability:** boot summary and exemption lines (SD-37, SD-18); rate-limited failure line (SD-23).
- **Compatibility:** Nest 10 and 11, Node >= 18, TS 4.9 declarations.
- **Security of the feature itself:** no material in logs or errors (SD-42); constant-time comparison
  is not needed (HMAC tokens are not used for authentication). AES-GCM with random 96-bit IVs is safe
  for at most 2^32 seals per seal key; `SealKeyProvider` implementations rotate `current()` well before
  that (README guidance, risk R10).
- **Availability:** no new runtime dependency on a network service except the app's own
  `SealKeyProvider` for `Remember.Sealed` scopes, which fails closed (SD-32).

## 10. Test plan

### 10.1 Unit tests (`src/sensitive/*.spec.ts`, `src/testing/*.spec.ts`)

**A. Compatibility and invariants**
- `compat: no privacy option keeps records, replies and messages identical` (SD-01)
- `compat: privacy false keeps 0.9.0 log text` (SD-01)
- `redactor never mutates its input (deep-frozen payload)` (SD-02, I1)
- `activator receives the original payload while sinks get redacted copies` (SD-02)
- `flow, hop and error lines are still emitted with a policy active` (SD-03)
- `error.channel logger never prints raw OutboundHttpError url, headers or body` (SD-04)
- `error.channel logger with privacy false keeps only name, message, code, status, url` (SD-04)
- `restOut error message carries no query string or userinfo` (SD-05)
- `in-progress errors keep the key out of message and sinks` (SD-43)

**B. Marking**
- `@Private marks fields on instances and subclasses` (SD-06)
- `privateFieldsOf turns decorator metadata into selectors` (SD-07)
- `selector grammar: dots, [*], **, quoted keys, case` (SD-08)
- `invalid selector fails boot with level and selector` (SD-08)
- `hidden headers are hidden case-insensitively` (SD-09)
- `idempotency key header is fingerprinted, or hidden without a fingerprint secret` (SD-09)
- `trace fields are never redacted` (SD-10, I7)
- `field rule on a protected trace field fails boot` (SD-10)

**C. Patterns and packs**
- `patterns redact nested strings, messages, stacks and causes` (SD-11)
- `pack resolution: pinned, latest, unknown` (SD-12)
- `secrets pack positive and negative corpus` (SD-12)
- `personal pack positive and negative corpus` (SD-12)
- `built-in pack rules use RE2-compatible syntax only` (SD-13)
- `personal false-positive corpus: timestamps, ids, offsets` (SD-24)
- `adjacent phone numbers are both redacted` (SD-24)
- `personal phone rule fingerprints by default` (SD-25)
- `hidden tokens name the rule; invalid names fail boot` (SD-26)

**D. Show values and fingerprints**
- `show values: one case per Show member` (SD-14)
- `Show.Ends never reveals more than half and hides short values` (SD-14)
- `fingerprint requires a fingerprint secret of 32 bytes` (SD-15, I6)
- `fingerprint token is a keyed HMAC with the secret id` (SD-15)
- `built-in fingerprint-or-hide rules hide without a fingerprint secret` (SD-15)
- `failed fingerprint secret refresh keeps the current secret and warns` (SD-16)

**E. Merge and safety**
- `merge: unions, stricter show wins, inner levels cannot weaken, ties keep the outer show` (SD-17, I5)
- `exemptions need a reason, are logged at boot and win over patterns` (SD-18)
- `regex safety rejects catastrophic and zero-length patterns` (SD-19)
- `regex engine port compiles every rule and reports rejects at boot` (SD-20)
- `long strings are cut after scanning, dropping the token that reaches the cut` (SD-21)
- `walker limits: depth, nodes, cycles, getters, toJSON, binary, Map and Set` (SD-22)
- `redaction failure writes a placeholder, never the raw value` (SD-23, I2)
- `redactor is not called when no sink writes` (SD-36)
- `boot reports all configuration errors at once` (SD-37, I8)
- `boot summary line has no data` (SD-37)
- `privacy errors carry the PrivacyError brand, kind, code and retryable` (SD-37)
- `inbound policy missed by discovery is validated at first plan build` (SD-44)
- `config errors and boot lines never print fingerprint secret or seal key material` (SD-42)

**F. Sinks**
- `wireTap copy AsShown delivers a hidden copy` (SD-28)
- `PrivacyEngine is injectable and scoped to its module` (SD-39)

**G. Durable records (one test per row of section 8.2)**
- `remember default: Everything without privacy, OutcomeOnly with one, defaulted scopes listed at boot` (SD-29)
- `outcome-only plus replay on request/reply fails boot` (SD-30)
- `matrix Everything|AsShown|Sealed|OutcomeOnly x success, envelope, replay, store, keep, activator` (SD-30; 24 parameterized cases)
- `sealed records: round trip, tamper, key swap` (SD-31, I3)
- `seal key provider down at claim fails closed before dispatch` (SD-32)
- `seal key provider down at replay never re-runs` (SD-32, I4)
- `retired seal key gives replay unavailable` (SD-32)
- `saga ledger: sealed round trip, seal key fetched outside the transaction` (SD-33, I9)
- `saga ledger: outcome-only replay` (SD-33)
- `activator duplicate on an outcome-only record warns and does not reply` (SD-34)
- `sealed and outcome-only records survive a JSON store` (SD-35)

**H. Testing helpers**
- `expectNoLeak finds every encoded form` (SD-38)
- `expectNoLeak never prints the secret` (SD-38)

**I. Flow DSL and channel integration (section 18; `src/flow/*.spec.ts`, `src/sensitive/policy-resolver.spec.ts`, `src/graph/channel-graph.spec.ts`)**
- `flow sinks use the failing step subject: union of module, source, destination, flow and step` (SD-45)
- `flow-level privacy applies to flow sinks only` (SD-46)
- `delivery-reach or remember at flow level fails boot` (SD-46, SD-58)
- `step and target privacy options are scoped to their own sinks` (SD-47)
- `profiles: extends, list union, cycle, depth and unknown names` (SD-48)
- `an unreferenced profile changes nothing` (SD-48)
- `privacy false below the module or with lower references fails boot` (SD-49)
- `delivery-reach masks only the step's own rules and only the delivered copy` (SD-50)
- `delivery-reach level and reason are validated at boot` (SD-50)
- `delivery-reach keeps untouched references and fails instead of truncating` (SD-51)
- `wireTap copies AsShown by default under explicit privacy; copy Original needs a reason` (SD-52, SD-28)
- `jump replies are redacted in sink copies and delivered intact` (SD-53)
- `flow DSL privacy references never change delivered messages` (SD-54, I1)
- `boot resolver reports every privacy finding once with subject and path` (SD-55, SD-37)
- `route resolves target plans once per channel` (SD-55)
- `call-level privacy names are validated before the request is sent` (SD-56)
- `profiles-only module options do not opt durable scopes or taps in` (SD-57, SD-29)
- `remember on flow or step levels fails boot; inherited remember is ignored there` (SD-58)
- `graph shows privacy profile names only, never rules or reasons` (SD-59)
- `boot summary lists flow and step subjects without rules` (SD-60)
- `engine stats count hidden values by rule, output and subject without values` (SD-61)
- `saga privacy names resolve only with an engine` (SD-63)
- `inbound defaults, activator and binding references resolve by name` (SD-64)
- `compat: flow DSL without options keeps 0.9.0 describe output, tap copies and envelopes` (SD-65)
- `inbound discovery warn line is redacted` (SD-66)
- `privacy members extend the SPI-445 flow scaffolding and keep 0.9.0 behaviour` (SD-67)

### 10.2 End-to-end and build tests

- `test/privacy-leak.e2e.spec.ts: no secret reaches any sink at debug level` (SD-27): one Nest app
  on loopback with an inbound REST request/reply endpoint (each `remember` value), a fire-and-forget endpoint,
  activators, a flow with a redacted wire tap, an outbound REST binding against a local server that
  echoes the key in its error body, a saga with a memory ledger, logging `hops: true` at `debug`; drives
  success, failure, duplicate and replay; `expectNoLeak` over the capture with a JWT, an API key, a
  phone, an email, a card number and an idempotency key. The leak e2e uses only the in-memory store
  and ledger; Redis/Postgres stores are covered by SPI-429's contract suite, which reuses
  `sealed and outcome-only records survive a JSON store` (SD-35).
- **(amended)** The leak e2e also builds the section 18.3 flow (profiles at L1, a channel profile,
  `FlowOptions.privacy`, step and target references, a default-redacted tap, a jump whose reply
  holds a card number, a `Reach.Delivery` transform) and asserts with `expectNoLeak` that no sink holds
  the secrets, while a destination spy asserts the delivered values of SD-54 (SD-45 to SD-54).
- `test/dist-identity.spec.ts: @Private metadata crosses ESM and CJS copies` (SD-06), a new case
  in the existing file, skipped until built.
- depcruise `sensitive-no-npm` and `test/dist-typescript4.spec.ts` (SD-40).
- SPI-444: `bench/sensitive.bench.ts` (SD-41).

## 11. Documentation to update (same PR)

- **README:** new section "Privacy" after "Tracing & idempotency". It opens with the one-sentence
  definition: *the trail is everything Estela itself writes: logs, idempotency records, saga ledgers,
  wire-tap copies, error envelopes and test captures.* Then: principle (logging stays on, copies
  only), marking (`@Private`, selectors, `DEFAULT_HIDDEN_HEADERS`), packs and `Show` values,
  `remember` with the matrix of 8.2, `reach` and `copy`, providers wiring, regex safety and `regexEngine`, threat-model guidance of 1.3.
  "Caveats" gains: `Remember.OutcomeOnly` and activator replies, `Remember.AsShown` replay, seal key
  retention must exceed the longest record TTL, seal key rotation before 2^32 seals, one fingerprint secret per environment, the
  encoded-content limit, the E.164 false negatives, the opt-in migration recipe of section 2.
- **AGENTS.md:** "Layer boundaries" gains `sensitive-no-npm`; "Adding features" gains "new pack ->
  `packs.ts` + corpus tests + version bump" and the new ports (`FingerprintSecretProvider`, `SealKeyProvider`,
  `RegexEngine`); "Testing rules" lists `captureTrail` and `expectNoLeak`; a new non-negotiable
  invariant: "sinks write redacted copies; never mutate the delivered message".
- **skills/:** `estela-setup` (providers, module options), `estela-flows` (`wireTap` `copy`,
  per-channel policies), `estela-testing` (`captureTrail`, `expectNoLeak`, the corpus),
  `estela-review` checklist (no payload in app logs without `forLog`; exception filters use
  `errorForTrail`; `remember` chosen for every replayable endpoint; idempotency keys built from opaque
  ids, not personal data).
- **CHANGELOG:** from the release tooling.

## 12. Dependencies on other tickets

```
SPI-445 ──► SPI-433 (this): builds on the flow parameter scaffolding and the care-only resolver
   │        SPI-445 shipped (SD-67, amended); SPI-433 lands second, stacked on SPI-445
   │
   ├──► SPI-429 stores: persist sealed / outcome-only records opaquely (contract unchanged, SD-35).
   │    SPI-433 does NOT use a store-level codec (D13); MR-20 is retired in the MR spec
   │    (its D17), so no recordCodec edge exists (Q9 resolved)
   ├──► SPI-430 OutboundGrpcGateway, SPI-436 SDK outbound: their errors go through errorForTrail;
   │    bindings accept `privacy` like OutboundRestOptions
   ├──► SPI-431 gRPC command inbound: command endpoints are the endpoint level of 6.6
   ├──► SPI-437 OTel bridge: span attributes through PrivacyEngine
   ├──► SPI-439 @InboundMcp: endpoint level, same remember rules
   ├──► SPI-444: benchmark sets budgets (SD-41); revisits maxScanBytes default
   ├──► SPI-445 (RS-): its RS-17a classifies SealKeyUnavailableError
   │    (retryable) and ReplayUnavailableError / SealBrokenError (terminal), owns
   │    the retry budget
   ├──► Shared ESTELA flow parameter model (with SPI-429, SPI-445, KA-): levels, profile
   │    references, `FlowParameterResolver`, step ids and `DUPLICATE_STEP_ID`
   │    (`FlowDefinitionError`) are defined there; this spec owns the privacy rows (section 18).
   │    (amended 2026-11-10) SPI-445 landed first and shipped the shared scaffolding and the
   │    resolver with care members only; SPI-433 adds the privacy members and the privacy pass
   │    (SD-67); SPI-429 adds the idempotency members (MR OQ-14 resolved: SPI-445 ships the resolver).
   │    SPI-445 owns care events (SD-62); SPI-429 owns step claims (SD-58)
   └──► Koletz adoption spec (KA-): its pack, header additions, per-channel table, fingerprint
        secret and seal key providers, and the D-PHONE choice per channel; it references profiles by name only
```

### Agreed delivery order (identical in the four SPI-428 specs) **(amended 2026-11-10)**

1. **SPI-445 care (resilience)** lands first. It ships the shared flow parameter scaffolding with
   its care members only: `FlowOptions`, `StepCommonOptions`, `FlowTarget`/`FlowDest`,
   `JumpOptions`, `ProfileName`, `FlowParameterFinding`, `FlowDefinitionError` and the care-only
   `FlowParameterResolver` (SD-67, RS 3.9). SPI-429 has not merged, so RS-50 is deferred to a
   follow-up that lands with the SPI-429 guard. SPI-430 and SPI-436 merge after it or rebase onto it.
2. **SPI-433 privacy (P0)**, stacked on SPI-445 (branch `feat/SPI-433-sensitive` on
   `feat/SPI-445-resilience`). It adds the privacy members to that scaffolding and the privacy pass
   to the resolver; it re-creates none of it. With SPI-432 (graph control, P0) it gates the first
   Koletz adoption step (A1); because it is stacked, A1 also waits for SPI-445 to merge.
3. **SPI-429 multi-replica (P1).** It adds the idempotency members to the same scaffolding and
   brings the RS-50 follow-up. Its boot guard is released and enabled in Koletz (KA-01, KA-02)
   before any service runs more than one replica or an HPA; until then the Koletz CI check KA-03
   blocks scaling. It does not gate A1.
4. **Koletz adoption (KA-)**, gated by the P0 items: A1 by SPI-433 (on SPI-445) + SPI-432; A4 by
   SPI-433 + SPI-431; A3 by SPI-445 (plus SPI-430 / SPI-436 for gRPC and SDK hops); A7 (shared
   store, scaling allowed) by the SPI-429 stores.

SPI-433 has one build-time dependency: it extends the scaffolding SPI-445 shipped. SPI-429 stays
soft against both (it only adds members). The order above is the release plan.

SPI-432 (graph control) is independent: the graph never carries payloads (S13). SPI-434, SPI-435,
SPI-438, SPI-440 to SPI-443 do not depend on this ticket; when they add sinks (a broker message log, a
webhook body log) they route them through `PrivacyEngine` and extend the leak e2e.

## 13. Risks

- **R1. Unknown secret formats.** Patterns only catch known shapes; field marking is the primary
  control and packs are a safety net.
- **R2. False positives.** Over-masking can hide useful values (for example a numeric id that passes
  the card rule). Accepted: the token names the rule, `skipKeys` and `exempt` fix it per scope.
- **R3. Encoded content.** A secret inside a base64 or compressed blob is not redacted at run time.
  `expectNoLeak` detects it in tests; binary values are never written (SD-22).
- **R4. Conservative regex analysis.** Some safe patterns are rejected; remedy: rewrite or a linear
  engine.
- **R5. `Remember.OutcomeOnly` changes duplicate behaviour.** Duplicates lose their body; request/reply replay
  is refused at boot, activator replies become silence plus a warning, and callers may hit a reply
  timeout. Documented in Caveats.
- **R6. Seal key retirement.** Retiring a seal key before the records it sealed expire makes those
  repeats fail (`REPLAY_UNAVAILABLE`). Key retention must exceed the longest TTL.
- **R7. Fingerprint secret compromise.** Tokens of low-entropy values become reversible (1.4).
- **R8. Cost of the baseline.** Every consumer gets pattern scanning on error lines; error paths only,
  measured in SPI-444.
- **R9. Policy drift between services.** Each service compiles its own policy; a value redacted in
  one may be logged by another. An adopter applies the same policy across its services (the Koletz
  adoption spec does so for Koletz).
- **R10. AES-GCM IV space.** Random 96-bit IVs are safe for at most 2^32 seals per seal key; a
  `SealKeyProvider` that never rotates exceeds it in very high-volume scopes. Documented; rotation is the
  provider's job.
- **R11. Opt-in changes duplicate behaviour.** Turning on any policy defaults durable scopes to
  `Remember.OutcomeOnly` (D5). Mitigated by boot failure for replay endpoints and the boot list of defaulted
  scopes (SD-29, SD-30).
- **R12. Key-name over-masking.** `secrets.keys` masks every key named `token`, including harmless
  ones (pagination tokens). Accepted; `exempt` with reason restores them per scope.
- **R13. Tap copies share subtrees.** A redacted tap copy shares unchanged subtrees with the live
  message (copy-on-write), as the 0.9.0 tap shares the whole payload; a subscriber that mutates its
  copy mutates the main path. Not an isolation boundary; README Caveats.
- **R14. `Reach.Delivery` with `Show.Fingerprint`.** Fingerprint tokens delivered downstream change on every `refreshFingerprintSecret()` that loads a new secret,
  so a remote service that stores them loses correlation. README guidance: prefer `Show.Hidden` or `Show.Omitted`
  for delivered data.
- **R15. Profile edits reach many subjects.** One profile change alters the redaction of every subject
  that references it; the boot summary (SD-60) and the graph names (SD-59) show the reach.

## 14. Decisions log

| # | Question | Decision | Reason |
|---|---|---|---|
| D1 | Redact the real message or copies | Copies for sinks only | Activators and remote services need real values; logging stays on |
| D2 | Fix the S3 and S11 leaks behind an option | No, unconditional `fix` | They are bugs; the 0.9.0 code already promises the url never reaches `message` |
| D3 | Baseline without configuration | pinned `secrets@1` pack + `DEFAULT_HIDDEN_HEADERS` (idempotency key hidden) on log sinks; stores untouched; `privacy: false` opts out | Safe default that changes no API or record |
| D4 | Bare selector meaning | Root key only | Explicit `**.` avoids surprise matches |
| D5 | Default `remember` under a policy | `Remember.OutcomeOnly` | Never stores a secret by default; replay endpoints fail at boot and must choose |
| D6 | `Remember.AsShown` replay as a default | Never; explicit only | Replaying `[HIDDEN]` as data silently corrupts callers |
| D7 | Sagas inheriting the module policy | Only through `SagaRunnerOptions.privacy` | The runner is built by the app, outside the module; no hidden coupling |
| D8 | `Show.Fingerprint` without a fingerprint secret | Boot error | Unsalted hashes of phones are reversible |
| D9 | Bypass of the regex analysis | None with the native engine; use a linear engine | A bypass would reintroduce ReDoS through config |
| D10 | Hidden token content | `[HIDDEN:<rule>]` | Debuggable false positives without data |
| D11 | `show` conflict on one path | Stricter wins | Lower levels can only add |
| D12 | Encryption | AES-256-GCM, AAD bound to `scope::key`, key id in the envelope | Integrity and anti-swap; rotation by id |
| D13 | Where `remember` is applied | Above the store (inbound gate, activator wrapper, saga runner), not through a store-level codec (MR-20, retired by the MR spec's D17) | Needs async key fetch before the claim, `scope`/`key` for the AAD, and must work with stores that predate SPI-429 |
| D14 | Fingerprint without a fingerprint secret for built-in rules | Fingerprint-or-hide: built-in rules use `Show.Hidden` when no fingerprint secret exists; only an explicit user `Show.Fingerprint` fails boot | Hidden is never weaker than a fingerprint; the baseline and `personal` stay usable without a fingerprint secret |
| D15 | Context checks in patterns | `confirm` hook in code, not consumed context characters | Consumed context makes adjacent values miss (`+502... +502...`); RE2 has no lookaround |
| D16 | Free `forLog` functions | Injectable `PrivacyEngine` only | No process-global state; two apps in one process (tests) keep their own policies |
| D17 | The S12 message leak | Unconditional `fix`: key removed from `IdempotencyInProgressError.message` | Same reasoning as D2; the inbound twin already omits it |
| D18 | Which channel is L2 for a send step's privacy policy | Source **and** destination (union) | The model names the destination; for a union concern adding the source never weakens and keeps data declared private on arrival protected when a send fails |
| D19 | Rules used by `Reach.Delivery` | Only the step's own reference (its `use` profiles and inline rules) | A module or channel edit must never change what remote services receive |
| D20 | Wire-tap default under a policy | Redacted by default only when an explicit privacy (SD-57) reaches the tap; 0.9.0 shared copy otherwise. The tap's levels also include the flow's source channel (a union superset of the model's rule 4.4) | The model says the tap copy is always redacted; the compat contract (section 2) requires 0.9.0 behaviour with no new configuration |
| D21 | Profiles-only module options | Not an explicit privacy (SD-57) | Declaring a library of profiles must not flip every durable scope to `Remember.OutcomeOnly` |
| D22 | Estela-own vocabulary for private data (2026-11-10) | Every name a user writes or reads follows section 19: option key `privacy` on every level (`forRoot({ privacy })`, `ChannelSpec.privacy`, `FlowOptions.privacy`, step and target `privacy`, decorators, bindings, saga runner); rule types `Privacy`, `PrivacyProfile`, `PrivacyRef`, `PrivacyModuleOptions`; the enums `Show`, `Remember`, `KeyCase`, `Reach`, `TapCopy`, `Pack`, `TrailOutput` and `LeakForm`; `exempt`/`Exemption`; `confirm`; `@Private`; the ports `FingerprintSecretProvider` and `SealKeyProvider`; `PrivacyEngine` (`forTrail`, `errorForTrail`, `textForTrail`, `forLog`, `rememberOf`, `refreshFingerprintSecret`); the `PrivacyError` family; the tokens `[HIDDEN:<rule>]`, `fp:<secretId>:<hex>` and `[HIDE_FAILED]`; the `personal` pack; `captureTrail`; the finding codes of 4.7 with concern `'privacy'`. The folder `src/sensitive/`, the `SD-` IDs and this file name stay; internal helpers keep plain engineering names; prose may still say redact, mask, hash, HMAC, salt and AES-GCM to explain the mechanism. No aliases: no `sensitive*` name ever shipped | Owner decision 2026-11-10 (proposal "intent", scored 24/25 against "veil" 21 and "minimal" 18): everyday words a flow author reads without the docs, next to `care` (D34 of the resilience spec), that do not give away the mechanism. Grafts: flat `fingerprintChars` (D34 kept options flat), `LeakForm` as an enum, the gap-filling finding codes, and uppercase `[HIDDEN:…]`/`[HIDE_FAILED]` tokens in the style of `[TRUNCATED]` |
| D23 | Delivery order and the shared scaffolding (2026-11-10) | SPI-433 lands after SPI-445, stacked on its branch. SPI-445 already shipped the flow parameter scaffolding with care members only; SPI-433 adds the privacy members and the privacy pass of `FlowParameterResolver`, and re-creates nothing (SD-67, amended; section 12). `FlowParameterFinding.concern` changes `'sensitive'` to `'privacy'` before SPI-445 reaches `main` | SPI-445 merged first in practice; extending the shipped types keeps one copy of each and keeps the RS-57, RS-66 and RS-67 rules in one owner |
| D24 | Reach of an `exempt` entry and of `skipKeys` (engine slice, 2026-11-10) | They act on the matched node only: field rules of the exempting level and outer levels are dropped for that node and their pattern rules skip a string at that node; descendants of an exempted object are still walked; rules of inner levels still apply | Safest reading of SD-18 (never leak): an exemption cannot silently open a whole subtree |
| D25 | When `Remember.Everything` needs `rememberReason` | Whenever it is written explicitly, at any level | "Under explicit privacy" is always true once `remember` is written (SD-57 counts `remember` as explicit) |
| D26 | Where the protected trace fields are (SD-10) | `headers.<field>` (and `headers.history[*]`) of a message-shaped value (`payload` plus a `headers` object); any selector that can match one of those paths fails boot (`**.id` included) | Payload keys named `id` or `timestamp` stay hideable; a selector that could touch a trace field is refused up front |
| D27 | How header rules match | `DEFAULT_HIDDEN_HEADERS`, `headers` and the idempotency key headers compile to case-insensitive field rules on `**.headers.<name>`, so `exempt` can weaken them like any field rule | One mechanism; message headers, raw inbound headers and `OutboundHttpError.headers` all sit under a `headers` key in a sink copy |
| D28 | Code for out-of-range limits, bad enum values and an unreadable fingerprint secret provider at boot | `INVALID_OPTION` (the code care already uses) | The vocabulary lists no code for them; boot must still fail (I8) |
| D29 | `@Private({ show: Show.Fingerprint })` without a fingerprint secret | Fingerprint-or-hide (hidden); decorator rules sit at the module level | Decorators are not seen at boot, so they cannot fail it; hidden is never weaker |
| D30 | Built-in pattern shapes | `personal.card` matches 4-6-5, 4-4-4-4 and plain 13..19 digit runs (a 19-digit card grouped 4-4-4-4-3 is a known false negative, R1); `secrets.basic-url` bounds the scheme to 32 chars and `secrets.bearer` hides any word after `bearer` | `confirm` cannot choose a shorter span, so greedy optional groups would make cards next to other digits leak; an unbounded scheme is quadratic on long letter runs (base64 blobs); over-masking is accepted (R2) |
| D31 | What `urlForTrail` drops | Userinfo, query string and fragment | A fragment can hold tokens (OAuth implicit flow) |
| D32 | `Remember.AsShown` codec built without the engine's hide function | Stores the outcome-only marker | Never stores a plain record by accident |
| D33 | Engine surface beyond 4.5 | `compile(options, scopes?, logger?)` takes an optional `PrivacyLogger` (no Nest import in `src/sensitive`); `PrivacyEngine.inspect` returns the findings instead of throwing, for the boot resolver (SD-55); `forDelivery` and `planOfScope` are `@internal` for the wiring slices | `src/sensitive` stays a leaf (`sensitive-no-npm`, `sensitive-is-leaf`) |
| D34 | Ties between rules of equal strength at the same level | The rule declared first wins (baseline headers before `secrets.keys`, so `authorization` shows `[HIDDEN:header]`) | Deterministic tokens |
| D35 | Walker output for objects with `toJSON`, Maps, Sets and an omitted root | Objects with a `toJSON` function are copied without it; Maps and Sets stay Maps and Sets (new ones when changed); an omitted root becomes `undefined` | A sink serializer must never call the original `toJSON` (SD-22); copy-on-write keeps types |
| D36 | `captureTrail` before the sinks are wired | `channel(registry, name)` records `error.channel` as `TrailOutput.ErrorEnvelope` and any other channel as `TrailOutput.WireTap`; `keepOriginals` only marks the capture so `expectNoLeak` refuses it | The engine slice has no sink that hands originals to the capture yet |
| D37 | README while the flow and step levels are not built (docs slice, 2026-11-11) | The README "Privacy" section documents only the levels that run (module, `inbound.privacy`, channel, endpoint, activator, saga runner, `wireTap` `copy`). The PCI and WhatsApp examples keep the final names but drop `FlowOptions.privacy`, the step `privacy` and the two `Reach.Delivery` uses (receipt transform, analytics target); a "Not in this build yet" note lists them with a link to section 18. `test/privacy-readme.spec.ts` runs both examples and asserts the README trail lines verbatim | A README that shows options the build ignores or refuses would mislead adopters; the examples gain back their flow parts when section 18 lands |
| D38 | `exempt` with `show: Show.Ends` on `+50255512678` | Shows `***2678` (defaults `showFirst: 0`, `showLast: 4`); the README prints that value, not `+502***678` | `Exemption` has no `showFirst`/`showLast` (vocabulary 2.1 dropped them), so `+502***678` cannot be produced; the README must print what the code writes |
| D39 | WhatsApp example without a fingerprint secret | The explicit `Show.Fingerprint` field rules fail boot (`FINGERPRINT_WITHOUT_SECRET`, D8, SD-15); only built-in rules such as `personal.phone-e164` fall back to `Show.Hidden`. The README says so instead of showing `[HIDDEN:wa.customer]` | D8 and SD-15 are requirements; a boot failure never leaks and is stricter than hiding |
| D40 | Nest's `ExceptionsHandler` in the leak e2e | The e2e installs an app exception filter that logs `errorForTrail(error)`, the README guidance of 1.3; an inbound replay is compared by `result`, since each reply envelope gets new ids as in 0.9.0 | The e2e found raw upstream errors in Nest's own handler, an app surface out of scope (1.3); the filter is what adopters are told to write |
| D41 | `FlowParameterFinding.concern` | `'sensitive'` renamed to `'privacy'` in this slice | Docs (`ESTELA_FLOW_PARAMETERS.md` FP-D2, RS-67) already name `'privacy'`; the member never shipped |
| D42 | `redactUrl` export | Kept: it shipped in 0.9.0, so removing it is a breaking change; `urlForTrail` is the privacy name and `test/privacy-barrel.spec.ts` allows only this pre-vocabulary export | Section 19.7 forbids aliases for names that never shipped, not the removal of shipped ones |
| D-PHONE | How phone numbers are shown | Customer numbers: `Show.Fingerprint` (HMAC, salted) by default; the platform's own business/sender numbers may use `Show.Ends` through an app rule | `Show.Ends` is identifying (1.4); owner default, may be overridden (Q2) |
| D-REDIS-DOWN | Shared state unavailable | Here: `SealKeyProvider` unavailable fails closed with a retryable error, never fail-open, for every sealed scope (stricter than the owner default for scopes without side effects: a fail-open sealed scope would have to store plaintext or skip the claim, and skipping the claim is already SPI-429's fail-open); `FingerprintSecretProvider` refresh failure keeps the last fingerprint secret, never unsalted. The idempotency store itself is SPI-429's (side-effecting channels fail closed, others configurable, default fail-closed); `remember` adds no fallback | Owner default, may be overridden (Q6) |

## 15. Open questions

| # | Question | Default taken | Owner |
|---|---|---|---|
| Q1 | Keep the baseline on by default (D3), or require an explicit `privacy` option? | On | ESTELA maintainer |
| Q2 | Confirm D-PHONE (`Show.Fingerprint` for customer numbers, `Show.Ends` only for business numbers) | As D-PHONE | Platform owner |
| Q3 | Allow a per-pattern bypass of the regex analysis with a logged reason? | No (D9) | ESTELA maintainer |
| Q4 | Activator duplicate on an outcome-only record: silence + warn (today's no-cache path) or a typed error to the reply channel? | Silence + warn | ESTELA maintainer |
| Q5 | Transform idempotency keys at rest (HMAC) in a follow-up ticket? | Not in SPI-433; guidance only | ESTELA maintainer |
| Q6 | Confirm D-REDIS-DOWN as applied to providers (no fail-open for `Remember.Sealed`) | As D-REDIS-DOWN | Platform owner |
| Q7 | `fingerprintChars` default 16 (64 bits) | 16 | ESTELA maintainer |
| Q8 | `maxScanBytes` default 64 KiB until SPI-444 measures | 64 KiB | ESTELA maintainer (SPI-444) |
| Q9 | Align the MR spec: drop or reword MR-20 (store-level codec) now that SPI-433 encodes above the store (D13) | Resolved 2026-11-09: MR-20 retired (MR spec D17) | ESTELA maintainer (SPI-429 author) |
| Q10 | Open the resilience ticket under SPI-428 and give its key, so section 12 and the error classification can name it | Resolved 2026-11-09: `SPI-445` (RS OQ-1) | Platform owner |
| Q11 | Confirm the `secrets.keys` key list (R12) | As in 6.4 | ESTELA maintainer |
| Q12 | Path of the shared ESTELA flow parameter model in `docs/` (section 18 links it by name until it lands; the same question as RS OQ-16 and MR OQ-14) | Not yet in the repo | ESTELA maintainer |
| Q13 | `privacy: false` at L1 with lower references: boot error (`PRIVACY_OFF_WITH_REFS`, SD-49) or lower references silently ignored? The model does not say | Boot error | ESTELA maintainer |
| Q14 | Error class when one boot has findings of several concerns (care and privacy): the model says "the class of its concern" | (amended) The rule of RS-67, shared by the three specs: one concern, its own class; several concerns, `FlowDefinitionError`; `findings` lists all as `FlowParameterFinding` | ESTELA maintainer (with SPI-445) |
| Q15 | `Reach.Delivery` on `route` targets: the model lists neither permission nor refusal | Refused (`DELIVERY_REACH_LEVEL`) | ESTELA maintainer |
| Q16 | If SPI-429 caches step results under `StepIdempotencyOptions`, step scopes become durable and need `remember` (SD-58) | Not cached; no `remember` on steps | ESTELA maintainer (SPI-429 author) |
| Q17 | Default step `id` (`<kind>#<index>`) in `describe()`: emitting it always breaks the 0.9.0 graph deep-equal (`insurance.spec.ts:61`); this spec emits `privacy` only when set (SD-59, SD-65) | (amended) The rule of RS-66, shared by the three specs: emit `id` only when it is explicit or when the step carries an annotation of any concern (`privacy`, `care`, an `idempotency` claim) | ESTELA maintainer (with SPI-432) |
| Q18 | Show `reach: Reach.Delivery` in the graph? The model's 5.1 has no key for it | Not shown; boot warn line only (SD-60) | ESTELA maintainer |

## 16. Definition of done

- All MUST requirements implemented; SD-20 and SD-39 implemented or explicitly deferred in the PR.
- Every test named in section 10 exists and passes; `npm run verify` green; `npm run comments:en`
  green on touched files; CI jobs green.
- Leak e2e passes at debug level with all four `remember` values.
- README, AGENTS.md and skills updated (section 11) in the same PR.
- No runtime dependency added; `sensitive-no-npm` rule in place.
- **(amended)** Every public name follows section 19 (D22); no export, option key, token, code,
  graph key or boot-line keyword uses a `sensitive*`, `redact*`, `mask*`, `salt*` or `storeMode`
  spelling.
- PR description per template, with `BREAKING CHANGE` absent (additive) and the three `fix` items listed.
- **(amended)** Section 18 implemented: every SD-45..SD-67 test of group I passes; the shared flow
  parameter model linked by path (Q12).
- Open questions Q1 to Q18 answered or carried to tickets; Q9 is already resolved (MR-20 retired,
  MR spec D17).
- The CHANGELOG lists the three `fix` items (S3, S11, S12) and the opt-in migration note.

## 17. Traceability

| Requirement | Test(s) | Ticket |
|---|---|---|
| SD-01 | `compat: no privacy option keeps records, replies and messages identical`; `compat: privacy false keeps 0.9.0 log text` | SPI-433 |
| SD-02 | `redactor never mutates its input (deep-frozen payload)`; `activator receives the original payload while sinks get redacted copies` | SPI-433 |
| SD-03 | `flow, hop and error lines are still emitted with a policy active` | SPI-433 |
| SD-04 | `error.channel logger never prints raw OutboundHttpError url, headers or body`; `error.channel logger with privacy false keeps only name, message, code, status, url` | SPI-433 |
| SD-05 | `restOut error message carries no query string or userinfo` | SPI-433 |
| SD-06 | `@Private marks fields on instances and subclasses`; `test/dist-identity.spec.ts: @Private metadata crosses ESM and CJS copies` | SPI-433 |
| SD-07 | `privateFieldsOf turns decorator metadata into selectors` | SPI-433 |
| SD-08 | `selector grammar: dots, [*], **, quoted keys, case`; `invalid selector fails boot with level and selector` | SPI-433 |
| SD-09 | `hidden headers are hidden case-insensitively`; `idempotency key header is fingerprinted, or hidden without a fingerprint secret` | SPI-433 |
| SD-10 | `trace fields are never redacted`; `field rule on a protected trace field fails boot` | SPI-433 |
| SD-11 | `patterns redact nested strings, messages, stacks and causes` | SPI-433 |
| SD-12 | `pack resolution: pinned, latest, unknown`; `secrets pack positive and negative corpus`; `personal pack positive and negative corpus` | SPI-433 |
| SD-13 | `built-in pack rules use RE2-compatible syntax only` | SPI-433 |
| SD-14 | `show values: one case per Show member`; `Show.Ends never reveals more than half and hides short values` | SPI-433 |
| SD-15 | `fingerprint requires a fingerprint secret of 32 bytes`; `fingerprint token is a keyed HMAC with the secret id`; `built-in fingerprint-or-hide rules hide without a fingerprint secret` | SPI-433 |
| SD-16 | `failed fingerprint secret refresh keeps the current secret and warns` | SPI-433 |
| SD-17 | `merge: unions, stricter show wins, inner levels cannot weaken, ties keep the outer show` | SPI-433 |
| SD-18 | `exemptions need a reason, are logged at boot and win over patterns` | SPI-433 |
| SD-19 | `regex safety rejects catastrophic and zero-length patterns` | SPI-433 |
| SD-20 | `regex engine port compiles every rule and reports rejects at boot` | SPI-433 |
| SD-21 | `long strings are cut after scanning, dropping the token that reaches the cut` | SPI-433 (default revisited in SPI-444) |
| SD-22 | `walker limits: depth, nodes, cycles, getters, toJSON, binary, Map and Set` | SPI-433 |
| SD-23 | `redaction failure writes a placeholder, never the raw value` | SPI-433 |
| SD-24 | `personal false-positive corpus: timestamps, ids, offsets`; `adjacent phone numbers are both redacted` | SPI-433 |
| SD-25 | `personal phone rule fingerprints by default` | SPI-433 |
| SD-26 | `hidden tokens name the rule; invalid names fail boot` | SPI-433 |
| SD-27 | `test/privacy-leak.e2e.spec.ts: no secret reaches any sink at debug level` | SPI-433 |
| SD-28 | `wireTap copy AsShown delivers a hidden copy` | SPI-433 |
| SD-29 | `remember default: Everything without privacy, OutcomeOnly with one, defaulted scopes listed at boot` | SPI-433 |
| SD-30 | `outcome-only plus replay on request/reply fails boot`; matrix cases (group G) | SPI-433 |
| SD-31 | `sealed records: round trip, tamper, key swap` | SPI-433 |
| SD-32 | `seal key provider down at claim fails closed before dispatch`; `seal key provider down at replay never re-runs`; `retired seal key gives replay unavailable` | SPI-433 (retry layer: SPI-445, RS-17a) |
| SD-33 | `saga ledger: sealed round trip, seal key fetched outside the transaction`; `saga ledger: outcome-only replay` | SPI-433 |
| SD-34 | `activator duplicate on an outcome-only record warns and does not reply` | SPI-433 |
| SD-35 | `sealed and outcome-only records survive a JSON store` | SPI-433 (reused by SPI-429 store tests) |
| SD-36 | `redactor is not called when no sink writes` | SPI-433 |
| SD-37 | `boot reports all configuration errors at once`; `boot summary line has no data`; `privacy errors carry the PrivacyError brand, kind, code and retryable` | SPI-433 |
| SD-38 | `expectNoLeak finds every encoded form`; `expectNoLeak never prints the secret` | SPI-433 |
| SD-39 | `PrivacyEngine is injectable and scoped to its module` | SPI-433 |
| SD-40 | depcruise `sensitive-no-npm`; `test/dist-typescript4.spec.ts` | SPI-433 |
| SD-41 | `bench/sensitive.bench.ts` | SPI-444 |
| SD-42 | `config errors and boot lines never print fingerprint secret or seal key material` | SPI-433 |
| SD-43 | `in-progress errors keep the key out of message and sinks` | SPI-433 |
| SD-44 | `inbound policy missed by discovery is validated at first plan build` | SPI-433 |
| SD-02 (amended) | as above, plus `flow DSL privacy references never change delivered messages` | SPI-433 |
| SD-17 (amended) | as above, plus `flow sinks use the failing step subject: union of module, source, destination, flow and step` | SPI-433 |
| SD-27 (amended) | as above (the leak e2e covers the section 18.3 flow, 10.2) | SPI-433 |
| SD-28 (amended) | as above, plus `wireTap copies AsShown by default under explicit privacy; copy Original needs a reason` | SPI-433 |
| SD-29 (amended) | as above, plus `profiles-only module options do not opt durable scopes or taps in` | SPI-433 |
| SD-37 (amended) | as above, plus `boot resolver reports every privacy finding once with subject and path` | SPI-433 |
| SD-45 | `flow sinks use the failing step subject: union of module, source, destination, flow and step` | SPI-433 |
| SD-46 | `flow-level privacy applies to flow sinks only`; `delivery-reach or remember at flow level fails boot` | SPI-433 |
| SD-47 | `step and target privacy options are scoped to their own sinks` | SPI-433 |
| SD-48 | `profiles: extends, list union, cycle, depth and unknown names`; `an unreferenced profile changes nothing` | SPI-433 |
| SD-49 | `privacy false below the module or with lower references fails boot` | SPI-433 |
| SD-50 | `delivery-reach masks only the step's own rules and only the delivered copy`; `delivery-reach level and reason are validated at boot` | SPI-433 |
| SD-51 | `delivery-reach keeps untouched references and fails instead of truncating` | SPI-433 |
| SD-52 | `wireTap copies AsShown by default under explicit privacy; copy Original needs a reason` | SPI-433 |
| SD-53 | `jump replies are redacted in sink copies and delivered intact` | SPI-433 |
| SD-54 | `flow DSL privacy references never change delivered messages` | SPI-433 |
| SD-55 | `boot resolver reports every privacy finding once with subject and path`; `route resolves target plans once per channel` | SPI-433 (resolver shipped care-only by SPI-445, SD-67; shared with SPI-429) |
| SD-56 | `call-level privacy names are validated before the request is sent` | SPI-433 (SDK and gRPC calls: SPI-436, SPI-430) |
| SD-57 | `profiles-only module options do not opt durable scopes or taps in` | SPI-433 |
| SD-58 | `remember on flow or step levels fails boot; inherited remember is ignored there` | SPI-433 (step claims: SPI-429) |
| SD-59 | `graph shows privacy profile names only, never rules or reasons` | SPI-433 (graph: SPI-432) |
| SD-60 | `boot summary lists flow and step subjects without rules` | SPI-433 |
| SD-61 | `engine stats count hidden values by rule, output and subject without values` | SPI-433 |
| SD-62 | `care events are redacted with the step privacy` | SPI-445 |
| SD-63 | `saga privacy names resolve only with an engine` | SPI-433 |
| SD-64 | `inbound defaults, activator and binding references resolve by name` | SPI-433 (gRPC out sinks: SPI-430) |
| SD-65 | `compat: flow DSL without options keeps 0.9.0 describe output, tap copies and envelopes` | SPI-433 |
| SD-66 | `inbound discovery warn line is redacted` | SPI-433 |
| SD-67 (amended) | `privacy members extend the SPI-445 flow scaffolding and keep 0.9.0 behaviour` | SPI-433 (scaffolding shipped by SPI-445, first in the agreed delivery order; SPI-429 adds its members later) |

## 18. Flow DSL and channel integration

Added 2026-11-09 for the epic goal "ESTELA must embrace these characteristics and receive the
parameters that let flows incorporate them". This section applies the **ESTELA flow parameter
model** (shared by SPI-433, SPI-429, SPI-445 and the KA adoption spec; the shared document is the
source of truth for levels, profile references and option shapes, and its path is fixed when it
lands in `docs/`, Q12) to the privacy concern. It restates only what this spec must test;
names and shapes are the model's.

### 18.1 Ground truth (0.9.0, verified)

| Fact | Code |
|---|---|
| No DSL method takes options except `jump(channel, { wait?, timeoutMs? })`; `wireTap(channel)` has none | `src/flow/integration-flow.ts:41-101` |
| `IntegrationFlow.from(source)` takes no options; `BuiltFlow` is `{ source, steps }` | `integration-flow.ts:14-17,41` |
| The tap copy shares the payload reference and copies headers; failures are swallowed | `flow/steps/wire-tap.step.ts:14-17`, `message.ts:139-141` |
| A jump reply payload is stored in `headers.jumpReplies[channel]` and travels on every later hop (`nextHop` keeps it) | `flow/steps/jump.step.ts:33,46,72`, `message.ts:129,160-168` (`nextHop` spreads `...prev`) |
| `reply({ payload: 'jumpMerge' })` sends `{ ...payload, jumpReplies }` to the caller | `flow/steps/reply.step.ts:23-26,36-38` |
| `wait: false` failures of fanout and jump become `{ fireAndForget, channel, error: serializeError(error), flow }` envelopes | `flow/steps/forget.ts:15-24` |
| A flow failure sends `{ flow, error: <raw>, causedBy }` to error.channel; the executor does not know which step failed once it rethrows | `flow/flow-executor.ts:78-83,139-150` |
| Step `describe()` output is recorded verbatim in the graph; tests assert it deep-equal | `graph/channel-graph.ts:125-127`, `src/example/insurance/insurance.spec.ts:61` |
| Activators subscribe in step 2 of `onModuleInit`, before flows (step 3) | `integration.module.ts:248-281` |
| `InboundDefaults` holds only `reply` and `idempotency` | `inbound/inbound.types.ts:275-278` |
| The boot inbound-discovery warn line prints `String(error)` and is not in the sink table of 0.3 | `integration.module.ts:347-350` |

**(amended) Base of this branch (SPI-445, verified 2026-11-10).** SPI-433 is stacked on
`feat/SPI-445-resilience`, which already changed the first two rows: `IntegrationFlow.from(source,
options?: FlowOptions)` exists (`flow/integration-flow.ts:84`), every step except `reply` takes
`StepCommonOptions` (`id` only) or `CareStepOptions`, `wireTap` takes `WireTapOptions`
(= `StepCommonOptions`, `integration-flow.ts:52,102`), `jump` takes `JumpOptions { wait?, timeoutMs?,
care?, id? }`, `FlowTarget` carries `care`, `describeDest` drops `care` from the graph
(`flow/flow-step.ts:87-151`), `FlowParameterFinding` already lists `'sensitive'` in its `concern`
union (`resilience/resilience.errors.ts:148-157`), and the care-only `FlowParameterResolver`
(`flow/flow-parameter-resolver.ts:174`) and `FlowDefinitionError` (`flow/flow-definition-error.ts:24`)
exist. The graph module block holds `careProfiles` only (`graph/channel-graph.ts:69-70,215`).
`bindGrpcOut` still takes `{ replyChannel? }` only (`adapters/grpc.adapter.ts:12-17`).

### 18.2 Levels for the privacy concern

The model's levels (L0 built-in, L1 module, L2 channel, L3 flow, L4 step/endpoint, L5 call) map onto
SD-17 as follows. Merge is SD-17 unchanged: union of `fields`, `headers`, `patterns` and `packs`;
per path the stricter `show` wins; `exempt` is the only way to weaken and applies to its own level and
the levels inside it; `remember` comes from the most specific level that sets it.

| Subject | Levels merged, outer to inner |
|---|---|
| `flow:<flow>` (flow claim failure record, flow error envelope) | L0 baseline, L1 module, L2 source channel, L3 `FlowOptions.privacy`, then the remaining levels of the failing step's subject: its L4 step and target levels and, for a send step, the destination L2 (SD-45) |
| `flow:<flow>#<stepId>`, non-send step (`filter`, `transform`, `handle`) | L1, L2 source channel, L3, L4 step |
| `flow:<flow>#<stepId>`, send step (`to`, `publish`, `route`, `fanoutTo`, `jumpTo`, `jump`) | L1, L2 source channel **and** L2 destination channel, L3, L4 step, L4 target |
| wire-tap copy | L1, L2 tap channel, L2 source channel, L3, L4 step (SD-52) |
| activator `activator:<Class>.<method>` | L1, L2 own channel, L4 `ActivatorOptions.privacy` |
| inbound `inbound:<channel>` | L1 module, L1 `InboundDefaults.privacy` (`forRoot({ inbound })`), L2 own channel, L4 `InboundSpec.privacy` |
| outbound REST / gRPC out | L1, L2 bound channel, L4 binding (`OutboundRestOptions.privacy`, `bindGrpcOut` options), L5 call |
| saga | `SagaRunnerOptions.privacy.rules` (plus L1 when `engine` is passed) |

The model names the destination channel as L2 of a send step. Because the privacy merge is a
union, this spec also unions the **source** channel for send steps (D18): the data that arrived on a
channel declared private stays protected when a send to an unconfigured channel fails. A union
never weakens, so this is a superset of the model's rule, not a change to it. For the same reason the wire-tap copy also unions the flow's source channel, which the model's rule 4.4 (module, tap channel, flow, step) leaves out (D20).

An inbound endpoint's own channel is its L2 here, as in the model's 1.1. The other two concerns do not
read it: care refuses channel defaults on inbound endpoints (RS-56, RS-37) and idempotency keeps
the 0.9.0 inbound chain (MR D19, MR OQ-16). Privacy keeps it because a union only adds rules, so the
difference cannot weaken another concern's behaviour.

Runtime caps are not levels and do not exist for this concern. Floors that no lower level lifts:
the baseline stays on unless L1 sets `false`; `remember: Remember.Everything` needs `rememberReason`;
`Reach.Delivery` needs `reachReason`; `copy: TapCopy.Original` needs `copyReason`.

### 18.3 Parameters a flow author writes

```ts
IntegrationModule.forRoot({
  privacy: {
    packs: [Pack.SecretsV1],
    fingerprintSecret: envFingerprintSecret('ESTELA_FP_SECRET', 'ESTELA_FP_SECRET_ID'),
    profiles: {
      personal: { packs: [Pack.PersonalV1] },
      card: { fields: [{ path: '**.pan', show: Show.Ends, showLast: 4 }] },
      'card-personal': { extends: ['card', 'personal'] },
    },
  },
  channels: [{ name: 'payments.charge', type: 'direct', privacy: 'card' }],
}, [{                                       // flows: second argument of forRoot (integration.module.ts:132-135)
    name: 'loan',
    build: () =>
      IntegrationFlow.from('loan.requests', { privacy: 'personal' })                 // L3
        .handle(enrich, { id: 'enrich', privacy: { fields: ['ssn'] } })         // L4
        .wireTap('loan.audit', { id: 'audit' })                                   // TapCopy.AsShown by default (SD-52)
        .jumpTo([{ channel: 'credit.check', privacy: 'card' }], { id: 'credit' }) // per target
        .transform(toPartnerShape, { id: 'partner', privacy: {
            fields: ['ssn'], reach: Reach.Delivery, reachReason: 'partner must not receive SSN' } })
        .to('partner.out', { id: 'send' }),
}]);
```

| DSL method | `privacy` | `reach: Reach.Delivery` | Sinks the step's subject governs |
|---|---|---|---|
| `filter(predicate, opts?)` | yes | no (`DELIVERY_REACH_LEVEL`) | flow error envelope on a predicate throw |
| `transform(fn, opts?)` | yes | yes, on its output | error envelope |
| `handle(fn, opts?)` | yes | yes, on its output | error envelope; step claim failure record (SPI-429); care events (SPI-445) |
| `wireTap(channel, opts?)` | yes | no (`DELIVERY_REACH_LEVEL`) | the tap copy (SD-52) |
| `fanoutTo(dests, opts?)`, `FlowTarget.privacy` | yes, per step and per target | yes, on each hop copy | error envelope; `wait: false` envelopes (`forget.ts`) |
| `jumpTo(dests, opts?)`, `jump(channel, { privacy?, id? })` | yes, per step and per target | yes, on each hop copy | error envelope; `wait: false` envelopes; `jumpReplies[<ch>]` in later sinks (SD-53) |
| `publish(channel, routingKey?, opts?)` / `publish(channel, opts)` | yes | yes, on the hop copy | error envelope |
| `route(fn, opts?)` | yes, resolved per target channel | no (`DELIVERY_REACH_LEVEL`, Q15) | error envelope |
| `to(channel, opts?)` | yes | yes, on the hop copy | error envelope |
| `reply(options?)` | no field | no | none: the reply is the caller's data (model 4.4) |

### 18.4 Requirements

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| SD-45 (amended) | MUST | Every sink a flow writes is redacted with the policy of a named subject resolved per 18.2. A step's sink copies use `flow:<flow>#<stepId>`; the flow error envelope (`flow-executor.ts:139-150`) and the flow claim failure record (`:80`) use `flow:<flow>` united with every level of the failing step's subject (its L4 step and target levels and, for a send step, the destination channel); the executor records which step failed before it rethrows. The flow error envelope carries the error and ids only, never the payload (`flow-executor.ts:141`), so these sinks redact the error's message, stack and own enumerable properties (SD-04, SD-11). Send steps unite the source and the destination channel (D18). | G module `fields: ['**.token']`, source channel `loan.requests` with `fields: ['**.card']`, destination channel `audit.out` with `fields: ['**.iban']`, flow `privacy: { packs: [Pack.PersonalV1] }`, an idempotency store, and a `publish('audit.out', { privacy: { fields: ['**.ssn'] } })` whose send throws an error with own enumerable properties `token`, `card`, `iban`, `ssn` and an E.164 phone in its `message`; W a message with an `idempotencyKey` runs; T the S3 line and the S8 failure record hold none of the five values; in another run a `handle` step without options throws the same error and its S3 line masks `token`, `card` and the phone but writes `iban` and `ssn` as-is | `flow sinks use the failing step subject: union of module, source, destination, flow and step` |
| SD-46 (amended) | MUST | `IntegrationFlow.from(source, options?: FlowOptions)` accepts `privacy?: PrivacyRef` (L3). It applies to every sink of that flow (18.2) and never to a delivered value. `reach: Reach.Delivery` at L3 fails boot (`DELIVERY_REACH_LEVEL`); `remember` at L3 fails boot (`REMEMBER_LEVEL`, SD-58). | G `from('a', { privacy: 'personal' })` (profile `personal` = `personal@1`) and a `handle` that throws an error whose message holds the email it received; W a message with an email runs; T the S3 line fingerprints or hides the email and the handler received it intact; G `from('a', { privacy: { reach: Reach.Delivery, reachReason: 'x' } })`; T boot fails naming flow and option path | `flow-level privacy applies to flow sinks only`; `delivery-reach or remember at flow level fails boot` |
| SD-47 (amended) | MUST | Every DSL step except `reply` accepts `StepCommonOptions` (`id?`, `privacy?`), and each `FlowTarget` of `fanoutTo`/`jumpTo` accepts `privacy?` (table 18.3). A target's policy applies only to that target's hop sinks and `wait: false` envelope; siblings resolve independently. | G `fanoutTo([{ channel: 'a', wait: false, privacy: { patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }] } }, { channel: 'b', wait: false }])` where both sends reject with an error whose message holds `XSECRET1234` (the `wait: false` envelope carries only `serializeError`, `forget.ts:17`, so a field rule could not reach it); W the step runs; T the envelope for `a` holds `[HIDDEN:test.x]`, the envelope for `b` holds `XSECRET1234` (no rule reaches `b`) | `step and target privacy options are scoped to their own sinks` |
| SD-48 (amended) | MUST | `PrivacyModuleOptions.profiles` declares named policies (`PrivacyProfile`, names `^[a-z0-9][a-z0-9._-]{0,63}$`). `extends` takes one name or a list, unioned in order; a cycle fails boot (`PROFILE_CYCLE`), a chain of more than 8 `extends` hops from any profile fails boot (`PROFILE_DEPTH`), an unknown name anywhere fails boot (`UNKNOWN_PROFILE`). L2..L5 accept a `PrivacyRef`: a name, a list of names (unioned in order), or an inline policy with `use`, unioned with the named profiles. A declared profile adds no rule anywhere until a level references it, but every declared profile is still compiled and validated at boot (an invalid selector or unsafe regex in an unreferenced profile fails boot). | G profiles `a extends b`, `b extends a`, a reference `'missing'` and a chain of 10 profiles (9 hops); W boot; T one `PrivacyConfigError` with `PROFILE_CYCLE`, `UNKNOWN_PROFILE` and `PROFILE_DEPTH` findings; a chain of 9 profiles (8 hops) boots; G a valid `card` profile referenced by nothing; T no sink output differs from the same app without it | `profiles: extends, list union, cycle, depth and unknown names`; `an unreferenced profile changes nothing` |
| SD-49 (amended) | MUST | `privacy: false` is valid only as `forRoot({ privacy: false })`. Anywhere else (`InboundDefaults.privacy`, L2..L5) it is a finding `PRIVACY_FALSE_BELOW_MODULE` (boot error, except first-call error for L5, SD-56). When `forRoot({ privacy: false })` is set, any `InboundDefaults` or L2..L4 privacy reference fails boot with `PRIVACY_OFF_WITH_REFS` (Q13), and an L5 reference fails its first call with the same code: a channel author must not believe a disabled engine protects them. | G `forRoot({ privacy: false, channels: [{ name: 'a', type: 'direct', privacy: { fields: ['x'] } }] })`; W boot; T `PrivacyConfigError` with `PRIVACY_OFF_WITH_REFS` naming channel `a`; G a step `privacy: false`; T `PRIVACY_FALSE_BELOW_MODULE` naming the step | `privacy false below the module or with lower references fails boot` |
| SD-50 (amended) | MUST | `privacy: { reach: Reach.Delivery, reachReason }` is accepted only on an L4 flow step or target of the kinds in 18.3; it masks the output of `transform`/`handle`, or the hop copy sent by `publish`/`to`/`fanoutTo`/`jumpTo`/`jump`, in the payload and in each `headers.jumpReplies` value; other headers are untouched. It uses only the rules of that step's own reference (its `use` profiles plus inline rules), never L1..L3 (D19). `reachReason` is 1..200 chars and is logged at boot (warn: subject and reason). Missing reason, or the option at L1..L3, on `filter`, `wireTap`, `route` or `reply`, fails boot (`DELIVERY_REACH_LEVEL`). On a send step the main path keeps the original message. | G a module rule `fields: ['**.email']` and `publish('p', { privacy: { fields: ['ssn'], reach: Reach.Delivery, reachReason: 'partner' } })` followed by `handle(spy)`; W a message with `ssn: '123'` and an `email`; T the `p` subscriber gets `ssn: '[HIDDEN:field]'`, `spy` gets `'123'`, one boot warn line names the step and reason; a module rule on `email` does not mask the delivered email | `delivery-reach masks only the step's own rules and only the delivered copy`; `delivery-reach level and reason are validated at boot` |
| SD-51 (amended) | MUST | A delivery-reach copy is faithful or the step fails: untouched subtrees keep their reference (Buffers, Dates, class instances); a node on a changed path is rebuilt only when it is a plain object or array. When the copy cannot be faithful (walk limit of SD-22 reached, a string the step's own pattern rules must scan exceeds `maxScanBytes`, a cycle or getter on a changed path, a non-plain object on a changed path, or the redactor throws), the step fails with non-retryable `DeliveryCopyError` (`DELIVERY_COPY_FAILED`) and nothing is sent. `[HIDE_FAILED]`, `[TRUNCATED]` and other SD-22 placeholders are never delivered as data. | G a delivery-reach `transform` with `fields: ['ssn']` and one pattern rule, whose output has a `Buffer` sibling of the masked field, and a second run whose output holds a 70 KiB string outside `ssn`; W both run; T the first delivers the same Buffer reference and the masked field; the second fails with `DELIVERY_COPY_FAILED`, reaches error.channel, and the destination receives nothing | `delivery-reach keeps untouched references and fails instead of truncating` |
| SD-52 (amended) | MUST | Wire-tap redaction (SD-28 amended). The tap copy's policy is the union of module, tap channel, source channel, flow and step. When any of these levels holds an explicit privacy (SD-57; the baseline does not count), the copy is redacted by default; `copy: TapCopy.Original` then keeps the 0.9.0 shared copy and needs `copyReason` (1..200 chars, logged at boot), else boot fails. With no explicit rule, the 0.9.0 copy is kept unless `copy: TapCopy.AsShown`, which applies the baseline. The tap stays fire-and-forget (`wire-tap.step.ts:16`). | G a module policy on `**.token` and `.wireTap('audit')`; W a message with a token; T the audit subscriber sees the mask and the main path the token; with `{ copy: TapCopy.Original }` boot fails; with `{ copy: TapCopy.Original, copyReason: 'raw audit store' }` the subscriber sees the token and boot logged the reason; with no policy and no option the subscriber receives the same payload reference | `wireTap copies AsShown by default under explicit privacy; copy Original needs a reason` |
| SD-53 (amended) | MUST | In any sink copy that includes message headers, each `headers.jumpReplies[<ch>]` value is redacted as a payload with the writing subject's policy united with L2 of `<ch>` and that jump target's `privacy`. A key of `jumpReplies` is a channel name and is kept. `reply({ payload: 'jumpMerge' })` and later hops deliver the original replies. | G `jumpTo([{ channel: 'credit.check', privacy: 'card' }])` whose reply holds `pan: '4111111111111111'`, then `.wireTap('audit')` and `.reply({ payload: 'jumpMerge' })` under a module policy, with a `replyChannel` on the message; W the flow runs; T the audit copy holds `jumpReplies['credit.check'].pan` as `***1111` (6.3 `Show.Ends`), and the reply to the caller holds the full `pan` | `jump replies are redacted in sink copies and delivered intact` |
| SD-54 (amended) | MUST | Delivered-data invariant for flows (extends SD-02, I1): with any combination of L1..L4 privacy references and no `Reach.Delivery`, the payload and headers delivered to handlers, next steps, `to`/`publish`/`route`/`fanoutTo`/`jumpTo` destinations, outbound calls and `reply` are the same references as with no privacy configuration. | G a deep-frozen payload, every DSL step with a `privacy` reference (its `filter`/`transform`/`handle` functions return their input unchanged), profiles at all levels; W the flow runs to `reply`; T no `TypeError`, every destination spy receives the same payload reference, and the reply payload is the input reference | `flow DSL privacy references never change delivered messages` |
| SD-55 (amended) | MUST | Boot resolution. `PrivacyEngine.compile` (7.1) compiles the module policy and the profiles; the `FlowParameterResolver` then resolves `InboundDefaults.privacy` (part of L1) and every L2..L4 `PrivacyRef` (channels, endpoints, activators, bindings, `bindGrpcOut`, flows, steps, targets) after channels are created and before activators subscribe, freezes one plan per subject, and throws one `PrivacyConfigError` whose `findings` lists every finding (`code`, `severity`, `subject`, `path`) and whose message names subject and option path, never values (SD-42). (amended) The resolver is shared with SPI-445 and SPI-429: when the same boot also has error findings of another concern, exactly one error is thrown with the class that RS-67 sets (`FlowDefinitionError`), and the privacy findings are carried in it as `FlowParameterFinding` with `concern: 'privacy'`. Warnings are logged once each. `route` resolves its plan per target channel at first use and caches it (at most one entry per registered channel); its profile names are still checked at boot. No per-message resolution happens for other steps. | G an unknown profile on a step, a cycle in profiles and a delivery-reach on a filter, in one app; W boot; T one error with three findings, message contains `flow 'loan' step 'credit': privacy.use unknown profile` and no rule body; no activator or flow is subscribed | `boot resolver reports every privacy finding once with subject and path`; `route resolves target plans once per channel` |
| SD-56 (amended) | MUST | L5 references (`OutboundRestCallOptions.privacy`, SDK and gRPC call options) are validated on the first call that carries them, against the frozen profile registry: an unknown name throws `PrivacyConfigError` (`UNKNOWN_PROFILE`) and `false` throws it with `PRIVACY_FALSE_BELOW_MODULE`, before the request is sent. | G `gateway.request(target, msg, { privacy: 'nope' })`; W called; T it rejects with `UNKNOWN_PROFILE` and the stub server received no request | `call-level privacy names are validated before the request is sent` |
| SD-57 (amended) | MUST | An "explicit privacy" (for the `remember` default of SD-29 and the tap default of SD-52) is a resolved reference that holds at least one rule (`fields`, `headers`, `patterns`, `packs`, `exempt`) or a `remember`. A module object that declares only `profiles`, providers (`fingerprintSecret`, `sealKeys`, `regexEngine`) or limits is not one. | G `forRoot({ privacy: { profiles: { personal: { packs: [Pack.PersonalV1] } } } })`, an activator with idempotency and no `remember`, and a flow with `.wireTap('audit')`; W boot, a request to the activator and a message through the flow; T the activator record is `Remember.Everything`, no defaulted-scope warn line is logged and the tap copy shares the payload reference | `profiles-only module options do not opt durable scopes or taps in` |
| SD-58 (amended) | MUST | Flow and step scopes have no `remember`. A `remember` written at L3 or on a flow step or target fails boot (`REMEMBER_LEVEL`); one inherited from L1 or L2 is ignored for flow and step scopes (it still governs durable scopes on that channel). Step claim records added by SPI-429 (`StepIdempotencyOptions`) hold no payload, and their failure records hold the error redacted with the step's subject; if SPI-429 later caches a step result, that scope becomes durable and SD-29 applies (Q16). | G channel `a` with `privacy: { remember: Remember.Everything, rememberReason: 'r' }`, a flow from `a`, and a step `privacy: { remember: Remember.Sealed }`; W boot; T one `REMEMBER_LEVEL` finding names the step, none names the channel | `remember on flow or step levels fails boot; inherited remember is ignored there` |
| SD-59 (amended) | MUST | Graph annotations (model 5.1) carry names only: step and dest `privacy` lists (profile names, pack names with version, `'inline'` for inline rules), `GraphFlowEntry.options.privacy`, `GraphNode.privacy`, `GraphInboundRef.privacy`, `GraphOutboundRef.privacy`. They never contain field paths, regex sources, `exempt` paths or reasons, `reachReason`, `copyReason` or `rememberReason`. A `privacy` key appears only where a non-baseline reference reaches the node or step. Declared profile names appear in `GraphSnapshot.module.privacyProfiles` (model 5.1, next to `careProfiles`) only when `privacy.profiles` is set. | G a flow with an inline rule on `**.ssn` with an exemption reason and a profile `personal`; W `GET /integration/graph`; T the step shows `privacy: ['secrets@1', 'personal', 'inline']` and the JSON contains neither `ssn` nor the reason; with no privacy configuration the snapshot deep-equals 0.9.0's | `graph shows privacy profile names only, never rules or reasons` |
| SD-60 (amended) | MUST | Boot observability for flows: the summary of SD-37 adds one info line per `flow:<flow>` and `flow:<flow>#<stepId>` subject that has a non-baseline policy (subject, profile names, pack versions, rule counts, `reach`), one warn line per delivery-reach step (`Reach.Delivery`; subject, reason) and one per original-copy tap (`copy: TapCopy.Original`; subject, reason). No rule body, path or value is printed. | G the 18.3 example; W boot; T one info line each for `flow:loan`, `flow:loan#enrich`, `flow:loan#audit`, `flow:loan#credit`, `flow:loan#partner`, `flow:loan#send`, one warn line for `partner`, and no info line contains a field path (`ssn`, `**.pan`) or a rule body (the warn line holds the author's `reachReason` text verbatim) | `boot summary lists flow and step subjects without rules` |
| SD-61 (amended) | SHOULD | `PrivacyEngine.stats()` returns monotonic counters of redactions by rule name, trail output and subject, plus `[HIDE_FAILED]` and `DELIVERY_COPY_FAILED` counts, with no values, so an app can export them and spot false positives (R2) and silent rule gaps. | G the `personal` pack and 3 sink writes each holding one phone; W `stats()`; T the count for `personal.phone-e164`/`log`/subject is 3 and the object holds no phone | `engine stats count hidden values by rule, output and subject without values` |
| SD-62 (amended) | SHOULD | Care events of a flow step, activator or binding (SPI-445) are sink copies of that subject: their error text, attributes and any payload go through `errorForTrail`/`forTrail` with the subject's privacy, and plan B values are never written to an event. | G a `handle` step with `care` and a step `privacy: { patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }] }`, failing with an error whose message holds `XSECRET1234`; W the `try.again` event is emitted; T the event holds `[HIDDEN:test.x]` and not `XSECRET1234` | SPI-445: `care events are redacted with the step privacy` |
| SD-63 (amended) | MUST | `SagaRunnerOptions.privacy.rules` accepts a `PrivacyRef`. Profile names resolve only through `engine`; a name without `engine` throws `PrivacyConfigError` (`UNKNOWN_PROFILE`) when the runner is built. | G a runner with `rules: 'personal'` and no `engine`; W `new SagaRunner(...)`; T it throws `UNKNOWN_PROFILE`; with `engine` the ledger write masks a phone | `saga privacy names resolve only with an engine` |
| SD-64 (amended) | MUST | The L4 references outside flows take a `PrivacyRef` and obey 18.2: `ActivatorOptions.privacy`, `InboundSpec.privacy`, the new `InboundDefaults.privacy`, `OutboundRestOptions.privacy`, and `bindGrpcOut(..., { privacy })` (shape here; SPI-430 wires its sinks). `InboundDefaults.privacy` applies to every inbound endpoint between module and channel. | G `forRoot({ privacy: { profiles: { personal: { packs: [Pack.PersonalV1] } } }, inbound: { privacy: 'personal' } })` and a request/reply `@InboundRest` endpoint without `privacy`, with `idempotency: { remember: Remember.AsShown, onDuplicate: 'envelope' }`, whose reply holds an email; W a request with an idempotency key; T the stored S6 record's `cachedResult` fingerprints or hides the email and the caller's reply holds it intact (an inbound handler's own throw reaches Nest's handler, not error.channel, section 1.3) | `inbound defaults, activator and binding references resolve by name` |
| SD-65 | MUST | Backward compatibility of the DSL: with no flow option, no step option and no profile set, every step's `describe()` output, the graph snapshot, the tap copy (same payload reference), the error envelopes and the delivered messages are exactly as in 0.9.0, and no resolver work runs per message (SD-36 holds). | G the existing flow, graph and insurance example suites; W they run on the new build; T they pass unmodified, and a redactor spy records zero calls on a successful flow with hop logging off | `compat: flow DSL without options keeps 0.9.0 describe output, tap copies and envelopes` |
| SD-66 (amended) | SHOULD | The boot inbound-discovery warn line (`integration.module.ts:347-350`, `String(error)`), a sink missing from the 0.3 table (S15, Estela-written but boot-time only), goes through `textForTrail` like S5. | G a discovery error whose message holds `https://u:p@h/x?token=SECRET`; W boot; T the warn line holds neither `u:p@` nor `SECRET` and boot continues | `inbound discovery warn line is redacted` |
| SD-67 (amended) | MUST | Privacy members on the shared scaffolding. (amended 2026-11-10) SPI-445 is the first library ticket of the agreed delivery order (section 12) and already ships the parts of the shared flow parameter model that every concern needs, with its care members only: `IntegrationFlow.from(source, options?: FlowOptions)`, `StepCommonOptions` (`id`) on every step except `reply` (which takes `id` only), `FlowTarget`/`FlowDest` on `fanoutTo`/`jumpTo`, `JumpOptions`, `WireTapOptions`, `StepParams`, `ProfileName`, `FlowParameterFinding`, `FlowDefinitionError` and the `FlowParameterResolver` at the boot position of 7.1. SPI-433, stacked on SPI-445, adds the privacy members to those types (`FlowOptions.privacy`, `StepCommonOptions.privacy`, `FlowTarget.privacy`, `JumpOptions.privacy`, `WireTapOptions.copy`/`copyReason`, the privacy references in `StepParams`), the privacy pass of the resolver (concern `'privacy'`, which replaces the unreleased `'sensitive'` member of `FlowParameterFinding.concern`), the graph `privacy` keys and `module.privacyProfiles`, and `bindGrpcOut`'s `care?`/`privacy?` options, with the same names and shapes; it re-creates none of the scaffolding. SPI-429 later adds the `idempotency` members (MR section 16.3) the same way. The rules are not restated here: the step id default and `DUPLICATE_STEP_ID` are owned by RS-57, the resolver position and the error class rule by RS-67, the graph `id` key by RS-66 (Q17). MR OQ-14 is resolved: SPI-445 ships the resolver; the model file location stays Q12. | G the SPI-433 build on SPI-445 without SPI-429; W a flow is built with two steps `{ id: 'x' }`; T flow build still fails with SPI-445's `FlowDefinitionError` and one `DUPLICATE_STEP_ID` finding (no second copy of the type exists); G `from('a', { privacy: 'personal' })` with profile `personal`; T it boots and resolves the L3 plan; G `from('a', { privacy: 'missing', care: { handle: 'nope' } })`; T one `FlowDefinitionError` carries an `UNKNOWN_PROFILE` finding with concern `'privacy'` and one with concern `'care'`; G the existing flow, graph, insurance and SPI-445 care suites; T they pass unmodified (SD-65) | `privacy members extend the SPI-445 flow scaffolding and keep 0.9.0 behaviour` |

### 18.5 Failure and edge behaviour

| Situation | Behaviour | Requirement |
|---|---|---|
| Unknown profile name at L2..L4 | boot fails, finding `UNKNOWN_PROFILE` with subject and path | SD-48, SD-55 |
| Unknown profile name at L5 | that call rejects before sending | SD-56 |
| Profile cycle or depth above 8 | boot fails | SD-48 |
| `privacy: false` at L2..L5; `false` at L1 with lower references | boot (L5: call) fails | SD-49 |
| `Reach.Delivery` at L1..L3, on `filter`, `wireTap`, `route` or `reply`, or without `reachReason` | boot fails, `DELIVERY_REACH_LEVEL` | SD-50 |
| `Reach.Delivery` cannot produce a faithful copy | step fails with `DELIVERY_COPY_FAILED`, non-retryable, nothing sent | SD-51 |
| `copy: TapCopy.Original` without `copyReason` under explicit privacy | boot fails, `COPY_REASON_MISSING` | SD-52 |
| `remember` at L3 or on a step/target | boot fails, `REMEMBER_LEVEL` | SD-58 |
| `route` resolves a channel that has no `ChannelSpec` | its L2 is empty; L1, source L2, L3 and L4 still apply | SD-55 |
| The same channel appears twice in one `fanoutTo` with different `privacy` | each target keeps its own plan | SD-47 |
| A tap subscriber mutates its copy | under copy-on-write, unchanged subtrees are shared with the main path (as the whole payload is in 0.9.0); not an isolation boundary (R13) | SD-52 |
| `Reach.Delivery` with `Show.Fingerprint` delivers tokens downstream | allowed; tokens change on fingerprint secret refresh (R14) | SD-50 |
| Mixed care and privacy error findings at boot | one throw whose `findings` lists all; class per RS-67 (Q14) | SD-55 |

### 18.6 Migration

- 0.9.0 apps: nothing to change (SD-65).
- Apps already on an SPI-433 pre-release with `ChannelSpec.privacy` objects: unchanged; an object is
  a valid `PrivacyRef`.
- Moving repeated inline policies into `profiles` is a refactor with no output change, except where
  the move turns a module object from rules to profiles-only (SD-57): durable scopes then go back to
  `Remember.Everything` and taps to shared copies. The boot summary (SD-37, SD-60) shows the change.
- Opting a flow into a policy turns its taps to redacted copies (SD-52); subscribers that need raw
  data must set `copy: TapCopy.Original` with a reason.

## 19. Estela-own vocabulary (amended 2026-11-10, D22)

Every name a user writes or reads (exports, option keys, tokens, finding codes, graph text and
boot-line keywords) uses the words below. Prose and comments may still say redact, mask, hash, HMAC,
salt and AES-GCM to explain the mechanism. No `sensitive*` name ever shipped, so there are no aliases.
The tables map the earlier draft names of this spec to the final ones; sections 0 to 18 already use
the final names.

### 19.1 Rules and module (4.1, 18.2, 18.3)

| Earlier draft | Final |
|---|---|
| `IntegrationModuleOptions.sensitive?: SensitiveModuleOptions \| false` | `privacy?: PrivacyModuleOptions \| false` (`false` is valid at L1 only) |
| `.sensitive` on `ChannelSpec`, `InboundSpec`, `InboundDefaults`, `ActivatorOptions`, `OutboundRestOptions`, `OutboundRestCallOptions`, `FlowOptions`, `StepCommonOptions`, `FlowTarget`, `jump(ch, {…})`, `bindGrpcOut(…, {…})` | `.privacy` (type `PrivacyRef`) |
| `SensitivePolicy`, `NamedSensitivePolicy`, `SensitiveModuleOptions`, `SensitiveRef`, `ScopePolicies` | `Privacy`, `PrivacyProfile`, `PrivacyModuleOptions`, `PrivacyRef`, `PrivacyScopes` |
| `profiles`, `extends`, `use`, `ProfileName`, `fields`, `headers`, `patterns`, `packs`, `FieldRule { path, name }`, `PatternRule { name, regex, group, skipKeys }` | unchanged |
| `PatternRule.accept` | `confirm` |
| `allow: AllowException[]` `{ path, mode?, reason }` | `exempt: Exemption[]` `{ path, show?, reason }` (`show` undefined: the path is shown as it is) |
| `storeMode: StoreMode`, `storeModeReason` | `remember: Remember`, `rememberReason` |
| `defaultMode` | `defaultShow` |
| `keyCase: 'insensitive' \| 'sensitive'` | `keyCase: KeyCase.Ignore \| KeyCase.Match` (default `Ignore`) |
| `salt: SaltProvider`, `hashChars` | `fingerprintSecret: FingerprintSecretProvider`, `fingerprintChars` (12..64, default 16) |
| `keys: KeyProvider` | `sealKeys: SealKeyProvider` |
| `regexEngine`, `maxScanBytes`, `maxDepth`, `maxNodes` | unchanged |
| `apply: 'sinks' \| 'mask-payload'`, `applyReason` | `reach: Reach.Trail \| Reach.Delivery` (default `Trail`), `reachReason` |
| prose "hash-or-mask", "explicit policy" | "fingerprint-or-hide", "explicit privacy" |

### 19.2 How a value is shown (4.1, 6.3)

| Earlier draft | Final | Output token |
|---|---|---|
| `MaskMode` / `MaskOptions`, `mode` | `Show` / `ShowOptions`, `show` | |
| `'mask'` (default) | `Show.Hidden = 'hidden'` | `[HIDDEN:<rule>]`; an object or array gets the same token |
| `'remove'` | `Show.Omitted = 'omitted'` | the key or array element is left out |
| `'partial'`, `keepFirst` / `keepLast` | `Show.Ends = 'ends'`, `showFirst` / `showLast` (defaults 0 and 4) | `+502***427`; `Show.Hidden` under 8 characters and for objects |
| `'hash'` | `Show.Fingerprint = 'fingerprint'` | `fp:<secretId>:<hex>`; `Show.Hidden` for objects |
| `'length'` | `Show.Length = 'length'` | `[HIDDEN:<rule> len=<n>]`, or `len=<entries>` for objects |
| `'replace'` / `replace` | `Show.Text = 'text'` / `text` | the literal text |
| precedence `remove > mask = replace > length > hash > partial` | `Omitted > Hidden = Text > Length > Fingerprint > Ends` | |

### 19.3 Tokens, packs and rule names

| Earlier draft | Final |
|---|---|
| `[REDACTED:<rule>]`, bare `[REDACTED]`, `[REDACTED:header]`, `[REDACTED:field]` | `[HIDDEN:<rule>]`, `[HIDDEN]`, `[HIDDEN:header]`, `[HIDDEN:field]` |
| `h:<saltId>:<hex>` | `fp:<secretId>:<hex>` |
| `[REDACTION_FAILED]` | `[HIDE_FAILED]` |
| `[TRUNCATED]`, `[truncated N bytes]`, `[Circular]`, `[Getter]`, `[Binary len=N]` | unchanged |
| header denylist | `DEFAULT_HIDDEN_HEADERS` (exported) |
| `PackName` `'secrets' \| 'pii' \| …@N` | `enum Pack` plus the `PackName` template type (4.1) |
| `'pii'`, `'pii@1'` | `Pack.Personal = 'personal'`, `Pack.PersonalV1 = 'personal@1'` |
| `'secrets'`, `'secrets@1'` | `Pack.Secrets`, `Pack.SecretsV1` (same strings) |
| `secrets.*` rule names | unchanged |
| `pii.email`, `pii.phone-e164`, `pii.card` | `personal.email`, `personal.phone-e164`, `personal.card` (`phone-e164` stays: it documents R1) |

### 19.4 Decorator, ports and engine (4.2 to 4.6)

| Earlier draft | Final |
|---|---|
| `@Sensitive(opts)`, `sensitiveFieldsOf`, `Symbol.for('@estela/nest.sensitive')` | `@Private(opts)`, `privateFieldsOf`, `Symbol.for('@estela/nest.private')` |
| `SaltMaterial { id, secret }`, `SaltProvider`, `envSaltProvider` | `FingerprintSecret { id, secret }`, `FingerprintSecretProvider`, `envFingerprintSecret` |
| `DataKey { id, key }`, `KeyProvider { current, byId }` | `SealKey { id, key }`, `SealKeyProvider { current, byId }` |
| `RegexEngine`, `CompiledPattern`, `nativeRegexEngine` | unchanged |
| `SensitiveRuntime` (`.compile`, `.redact`, `.redactError`, `.redactText`, `.redactForLog`, `.storeModeOf`, `.rotateSalt`) | `PrivacyEngine` (`.compile`, `.forTrail`, `.errorForTrail`, `.textForTrail`, `.forLog`, `.rememberOf`, `.refreshFingerprintSecret`), a Nest provider exported like `CareEngine` |
| `.stats()` `{ byRule, bySink, bySubject, redactionFailed, maskFailed }` | `{ byRule, byOutput, bySubject, hideFailed, deliveryCopyFailed }` |
| `SinkKind`, `RedactContext { sink, … }` | `enum TrailOutput`, `TrailContext { output, channel?, scope? }` |
| `redactUrl` | `urlForTrail` |
| `HopLogger(level?, redactor?)` | `HopLogger(level?, privacy?: PrivacyEngine)` |
| `SEALED_RECORD_KEY = 'estelaSealed'`, `RecordSealer` | unchanged |
| `STATUS_ONLY_RECORD_KEY = 'estelaStatusOnly'`, `RecordCodec.storeMode`, `{ statusOnly: true }` | `OUTCOME_ONLY_RECORD_KEY = 'estelaOutcomeOnly'`, `RecordCodec.remember`, `{ outcomeOnly: true }` |
| `Logger('EstelaSensitive')` | `Logger('EstelaPrivacy')` |

### 19.5 Durable values and wire tap (4.1, 4.8, SD-52)

| Earlier draft | Final |
|---|---|
| `'plain'`, `'redacted'`, `'encrypted'`, `'status-only'` | `Remember.Everything = 'everything'` (needs `rememberReason` under explicit privacy), `Remember.AsShown = 'as-shown'`, `Remember.Sealed = 'sealed'`, `Remember.OutcomeOnly = 'outcome-only'` |
| `InboundIdempotencyOptions.storeMode` | `.remember` |
| `SagaRunnerOptions.sensitive { policy, storeMode, keys, runtime, replyOnReplay }` | `SagaRunnerOptions.privacy { rules, remember, sealKeys, engine, replyOnReplay }` |
| `wireTap(ch, { redact?, redactReason? })`, `redact: true`, `redact: false` | `wireTap(ch, { copy?: TapCopy, copyReason? })`, `copy: TapCopy.AsShown`, `copy: TapCopy.Original` (needs `copyReason` under explicit privacy) |

### 19.6 Errors, findings, graph, boot and testing (4.7, 4.9, 18.4, 18.5)

| Earlier draft | Final |
|---|---|
| (none) | `abstract PrivacyError extends Error`, brand `Symbol.for('@estela/nest.PrivacyError')`, `[Symbol.hasInstance]` like `CareError`; `kind` and `retryable` on every subclass |
| `SensitiveConfigError { problems, findings }` | `PrivacyConfigError` (`kind: 'config'`) |
| `SensitiveKeyUnavailableError` / `SENSITIVE_KEY_UNAVAILABLE` | `SealKeyUnavailableError` (`'seal-key'`, `SEAL_KEY_UNAVAILABLE`, retryable) |
| `SensitiveReplayUnavailableError` | `ReplayUnavailableError` (`'replay'`, `REPLAY_UNAVAILABLE`) |
| `SensitiveRecordError` / `SENSITIVE_RECORD_INVALID` | `SealBrokenError` (`'seal-broken'`, `SEAL_BROKEN`) |
| `SensitiveMaskError` / `SENSITIVE_MASK_FAILED` | `DeliveryCopyError` (`'delivery-copy'`, `DELIVERY_COPY_FAILED`) |
| `SensitiveFinding` | `PrivacyFinding { code, severity, subject, path }` (path `privacy.<…>`) |
| `SENSITIVE_FALSE_BELOW_MODULE`, `SENSITIVE_DISABLED_WITH_REFS`, `MASK_PAYLOAD_LEVEL` (also a missing `applyReason`), `STORE_MODE_LEVEL` | `PRIVACY_FALSE_BELOW_MODULE`, `PRIVACY_OFF_WITH_REFS`, `DELIVERY_REACH_LEVEL` (also a missing `reachReason`), `REMEMBER_LEVEL` |
| problems described only in prose | the new codes of 4.7 (`EXEMPT_REASON_MISSING` to `UNSAFE_PATTERN`) |
| `FlowParameterFinding.concern` `'sensitive'` | `'privacy'` |
| `sensitive?: string[]` on graph nodes, refs, flow options, steps and dests; `GraphSnapshot.module.profiles` | `privacy?: string[]`; `GraphSnapshot.module.privacyProfiles` |
| boot lines "apply mode", "mask-payload step", "redact:false tap" | "reach", "delivery-reach step", "original-copy tap" |
| `captureSinks({ unsafeRaw? })`, `SinkCapture` (`.unsafeRaw`), `CapturedWrite { sink, where, text }` | `captureTrail({ keepOriginals? })`, `TrailCapture` (`.keepOriginals`), `TrailWrite { output, where, text }` |
| `LeakForm` union with `'plain'` | `enum LeakForm` with `AsIs = 'as-is'` (other members keep their strings) |
| `expectNoLeak`, `leakForms` | unchanged |

### 19.7 What stays internal

- The folder `src/sensitive/`, the depcruise rule `sensitive-no-npm`, the `SD-` IDs and this file
  name stay (D34 of the resilience spec kept `src/resilience/`).
- Internal files and helpers use plain engineering names (section 5): `walk`, `cloneOnWrite`,
  `compileSelector`, `analyzeRegex`, `resolvePlan`, `FrozenPlan`, the HMAC helper, the AES-GCM
  helper `seal`/`open`, the Luhn and adjacent-digit checks. The inbound helper `statusOnlyFailure`
  is renamed `outcomeOnlyFailure` for consistency only.
- The same PR updates `ESTELA_FLOW_PARAMETERS.md` (concern `'privacy'`, codes) and RS-43 of
  `ESTELA_RESILIENCE_SPEC.md` (`'hash'` becomes `Show.Fingerprint`).
