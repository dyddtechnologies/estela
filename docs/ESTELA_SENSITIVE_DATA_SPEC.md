# Estela: sensitive-data policy spec

Status: draft, not implemented. Base: `20ae298` (`chore(release): 0.9.0`), branch

Shared flow parameter model: [`ESTELA_FLOW_PARAMETERS.md`](./ESTELA_FLOW_PARAMETERS.md) (proposed location; see the open location question).
`docs/SPI-428-koletz-readiness-specs`. Ticket: **SPI-433** (epic SPI-428). Requirement prefix: `SD-`.
Ships first in the SPI-428 series (highest risk). Release type: minor (`feat`), with three `fix`
commits for the leaks in section 0.3 (S3, S11, S12). Cross-spec consistency pass (2026-11-09, with
SPI-445, SPI-429 and the KA- spec): SD-55 is marked "(amended)"; Q10 is resolved; Q14 and Q17 take
the defaults of RS-67 and RS-66. Second pass (2026-11-09): SD-67 is new (SPI-433 ships the shared
flow parameter scaffolding, being first in the agreed delivery order); section 4.8 takes the `id` rule of RS-66.

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

1. Field marking: `@Sensitive()` on DTO properties, path selectors with `[*]` and `**`, a header
   denylist.
2. Regex rules applied on the way, at any depth, including error messages, stacks and error properties.
3. Built-in packs `secrets` and `pii` (versioned). No product-specific pack.
4. Masking modes `mask`, `remove`, `partial`, `hash` (HMAC through a `SaltProvider` port), `length`,
   `replace`.
5. Coverage of sinks S1 to S12 and S14.
6. `storeMode` for durable sinks (S6 to S9): `plain`, `redacted`, `encrypted` (through a `KeyProvider`
   port), `status-only`, with a defined interaction against inbound `onDuplicate`/`onFailure` and saga
   ledger replay.
7. Merge and inheritance rules, explicit `allow` exceptions with a reason logged at boot.
8. Regex safety: boot validation against catastrophic backtracking, optional linear engine
   (RE2-compatible port), `maxScanBytes`.
9. A false-positive policy, with match acceptance checks done in code (digit adjacency, Luhn).
10. A fix for the three leaks Estela has today (S3, S11, S12), shipped unconditionally.
11. Testing helpers `captureSinks()` and `expectNoLeak()` with an encoded-forms corpus.
12. **(added)** Flow parameters (section 18): named `profiles`, `SensitiveRef` at every level,
    `FlowOptions.sensitive` (flow level), `StepCommonOptions.sensitive` and `FlowTarget.sensitive`
    (step and target level), the `mask-payload` exception, and graph annotations by name, following
    the shared ESTELA flow parameter model.

### 0.5 Non-goals

- A Koletz pack, Koletz header names or per-channel Koletz configuration (Koletz adoption spec).
- Sinks outside Estela: heap dumps and core files, APM/OpenTelemetry exporters (SPI-437 will route its
  span attributes through this redactor when it exists), Nest's own `ExceptionsHandler` logs, the
  app's own logger calls, HTTP access logs, database query logs. Section 1.3 gives guidance; the
  injectable `SensitiveRuntime` exposes `redactForLog`/`redactError` for them (SD-39).
- Changing what reaches remote services: outbound request bodies, gRPC requests and replies are the
  real message and are never redacted.
- Transforming idempotency **keys** at rest (they are identities; open question Q5).
- Decoding encoded content at run time (base64 blobs, compressed bodies). Encoded leaks are detected by
  `expectNoLeak` in tests, not prevented by the runtime (risk R3).
- Broker-backed channels (SPI-434) and resilience policies (SPI-445, `RS-` requirements). No rule here depends on them. This ticket adds no retry loop and
  consumes no retry budget: its errors only carry `retryable` (section 8.1).
- Performance budgets. Overhead is measured and budgets are set in SPI-444 (SD-41).
- Outbound REST `retry`/`timeoutMs`: untouched by this ticket. `OutboundRestOptions` and
  `OutboundRestCallOptions` only gain `sensitive`.

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
`SaltProvider`/`KeyProvider` secrets.

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
| Nest `ExceptionsHandler` / app exception filters | Inject `SensitiveRuntime` and log `runtime.redactError(error)` instead of the error; never echo `error.message` of an upstream error to clients. `InboundIdempotencyInFlightError` reaches this surface (S12) |
| App logger calls | Use `runtime.redactForLog(value, { channel })` for anything that came from a payload |
| OTel / APM exporters | Do not record payloads as span attributes; SPI-437 will route attributes through the redactor |
| Heap dumps, core files | Treat as secret-bearing; restrict access; never attach to tickets |
| `OutboundHttpError.body/headers/url` read by app code | They stay intact on the thrown error (the app needs them); only sink copies are redacted |
| Idempotency keys as storage keys (Redis key names, Postgres primary keys) | Build keys from opaque ids, never from personal data; key transformation at rest is Q5 |

### 1.4 Hashing: brute force and salt rotation

- **Low-entropy values.** Phone numbers have roughly 10^7 to 10^11 candidates per country; an unsalted
  or leaked-salt hash of a phone number is reversed by enumeration in minutes. Truncating the hash
  does not help. Therefore `hash` is always an HMAC with a secret salt (SD-15), the salt is a secret
  of the same class as the data, and hashed values in logs are pseudonymous personal data, not
  anonymous data.
- **`partial` is identifying.** `+502***427` leaves about 10^4 candidates for a known country and
  prefix; with context (time, campaign) it is often unique. This is why customer numbers default to
  `hash` (D-PHONE).
- **Rotation.** A new salt changes every token: values hashed before and after a rotation do not
  correlate. Tokens carry the salt id (`h:<saltId>:<hex>`) so a reader can tell a rotation from a
  different value. There is no dual-salt mode: correlation across a rotation is given up on purpose.
- **Salt leak.** Every token written with that salt must be considered reversible for low-entropy
  values; rotate and treat the affected log range as containing personal data.
- **Salt scope.** One salt per environment. Sharing a salt across environments lets a token from a
  lower environment's logs be correlated with production; the README says so.

## 2. Backward-compatibility contract

- **No `sensitive` option.** Public APIs, the message delivered to every handler, replies, idempotency
  records, saga ledger rows and wire-tap copies are byte-for-byte as in 0.9.0. Log sinks apply the
  **baseline**: the pinned `secrets@1` pack and the default header denylist (with the idempotency
  key headers masked, since the baseline has no salt), on S1, S2, S3 and S5 only (D3) **(amended)**, plus S15 once SD-66 is implemented. A later
  `secrets@2` never changes the baseline outside a release note.
- **`sensitive: false`.** Restores the 0.9.0 log text exactly, except for the three fixes below.
- **Three unconditional fixes** (`fix` commits, not behind an option):
  1. S3 no longer runs `JSON.stringify` on raw error objects. With a runtime (baseline or policy),
     errors are written as `{ name, message, code?, status? }` plus redacted own enumerable
     properties; with `sensitive: false` only `{ name, message, code?, status?, url? }` is written.
     Any `url` goes through `redactUrl` (SD-04).
  2. S11: `restOut` errors print `redactUrl(options.url)` (SD-05).
  3. S12: `IdempotencyInProgressError.message` becomes `IDEMPOTENCY_KEY_IN_PROGRESS: <scope>`, like
     the inbound error; the `key` property stays for app code (SD-43). No test or README line asserts
     the old text (checked: only the inbound message is asserted, `inbound.adaptable.spec.ts:942`).
- **Additive types only.** Every new member of an existing public type is optional:
  `IntegrationModuleOptions.sensitive`, `ChannelSpec.sensitive`, `InboundSpec.sensitive`,
  `InboundIdempotencyOptions.storeMode`, `ActivatorOptions.sensitive`, `OutboundRestOptions.sensitive`,
  `OutboundRestCallOptions.sensitive`, `SagaRunnerOptions.sensitive`, `IntegrationFlow.wireTap(channel, options?)`, a second optional
  `HopLogger` constructor parameter. No port a consumer implements changes (`IdempotencyStore`,
  `IdempotencyLedger`, `LockPort`, `TransitionPort`, `ChannelFactory`, `InboundTransportStrategy`).
- **Store contract.** Sealed and status-only records are plain JSON-safe `Record<string, unknown>`
  values, so `MemoryIdempotencyStore` and existing custom stores (the README Redis contract) work
  unmodified (SD-35).
- The emitted `.d.ts` stays parseable by TypeScript 4.9 (`test/dist-typescript4.spec.ts`).
- Outbound REST `retry`/`timeoutMs`: unchanged; nothing to migrate in this ticket. Their migration to
  the resilience policy model belongs to SPI-445 (RS-34).
- **Flow DSL and parameter references (section 18).** Every new parameter is an optional trailing
  argument or an optional member: `IntegrationFlow.from(source, options?)`, `StepCommonOptions` on the
  DSL steps, `FlowTarget.sensitive`, `SensitiveModuleOptions.profiles`, and `SensitiveRef` in place of
  `SensitivePolicy` wherever a level accepts a policy (a `SensitivePolicy` object is still a valid
  `SensitiveRef`). With none of them set, step `describe()` output, the graph snapshot, tap copies and
  delivered messages are as in 0.9.0 (SD-65); the existing describe assertions
  (`src/example/insurance/insurance.spec.ts:61`, `{ kind: 'wireTap', channel }`) keep passing.
- **Migration when a team opts in.** Setting any `sensitive` object changes the default `storeMode`
  of every durable scope it reaches to `status-only` (D5). Visible effects: request/reply endpoints
  with `onDuplicate: 'replay'` fail boot until they choose a `storeMode` (SD-30), and activator
  duplicates stop re-sending cached replies (SD-34). Boot lists every scope whose `storeMode` was
  defaulted (SD-29), so the change is seen at deploy time, not at the first duplicate. Recipe in the
  README: start with `storeMode: 'plain'` plus `storeModeReason` per scope, then tighten.
  **(amended)** A second visible effect of opting in: wire-tap subscribers whose tap is reached by
  the new policy start to receive redacted copies (SD-52). A tap that must keep the raw payload sets
  `redact: false` with a `redactReason`. Declaring only `profiles` changes nothing until a level
  references one (SD-57).

## 3. Requirements

RFC 2119 keywords. Every requirement has one acceptance criterion and at least one named test
(section 10). File paths are under `src/` unless stated.

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| SD-01 | MUST | Without a `sensitive` option, behaviour is as in section 2: stores, replies, ledger and delivered messages unchanged; log sinks apply the baseline. `sensitive: false` restores 0.9.0 log text except for the three fixes (SD-04, SD-05, SD-43). | G an app on 0.9.0 config; W the inbound, activator, flow and saga suites run; T records and replies deep-equal 0.9.0, and S1/S2/S3/S5 text differs only where a `secrets@1` rule or the header denylist matched or one of the three fixes applies | `compat: no sensitive option keeps records, replies and messages identical`; `compat: sensitive false keeps 0.9.0 log text` |
| SD-02 | MUST | Redaction produces a copy for a sink; it never mutates the input, and the message delivered to activators, flows and remote services and the error thrown to callers are the originals. **(amended)** The only exception is an L4 flow step option `sensitive: { apply: 'mask-payload', applyReason }` (SD-50); no other option changes a delivered value (SD-54). | G a deep-frozen payload with secrets; W every sink writes; T no `TypeError` from frozen writes, the activator receives the same reference, the thrown error keeps its original `message` | `redactor never mutates its input (deep-frozen payload)`; `activator receives the original payload while sinks get redacted copies` |
| SD-03 | MUST | A policy never disables or suppresses a log line: flow, hop, error, boot and wire-tap output keep firing with redacted content and the same structure (keys, ids, sizes when `length`). | G `logging.hops: true`, a policy, a flow whose step fails and a saga whose afterCommit callback throws (runner built with a `HopLogger` and `sensitive.runtime`); W both run; T `flowStart`, `flowEnd ... error`, the error.channel line, the saga `hopStart`/`hopEnd FAIL` and `hopError` lines are all emitted, with the same count as without a policy | `flow, hop and error lines are still emitted with a policy active` |
| SD-04 | MUST | The default `error.channel` logger never runs `JSON.stringify` on a raw error. With a runtime (baseline or policy) it writes `{ name, message, code?, status? }` plus the redacted own enumerable properties; with `sensitive: false` it writes `{ name, message, code?, status?, url? }` only. Any `url` property goes through `redactUrl`. Non-`Error` thrown values (`{ value }` envelopes) are redacted like payloads. | G no `sensitive` option (baseline) and a flow whose outbound fails with `OutboundHttpError` for `https://u:p@h/x?api_key=SECRET1`, response header `set-cookie: SECRET2` and body `{ token: 'SECRET3' }`; W the error reaches error.channel; T the line contains none of `SECRET1..3`, `u:p@` or `?api_key`, and contains `https://h/x` and the status; with `sensitive: false` the line holds no `headers` or `body` key | `error.channel logger never prints raw OutboundHttpError url, headers or body`; `error.channel logger with sensitive false keeps only name, message, code, status, url` |
| SD-05 | MUST | `restOut` error messages use `redactUrl`. | G `restOut` to `https://u:p@h/x?token=SECRET` answering 500; W it throws; T `message` names `https://h/x` and the status, with no query string or userinfo | `restOut error message carries no query string or userinfo` |
| SD-06 | MUST | `@Sensitive(options?)` marks DTO properties without `reflect-metadata`; metadata is found through the constructor prototype chain (subclasses inherit, may add) and through a global symbol registry, so it is visible across the ESM and CJS copies of the package. | G `class B extends A` with `@Sensitive()` on `A.secret`; W an instance of B is redacted by the CJS build while the decorator ran in the ESM build; T `secret` is masked | `@Sensitive marks fields on instances and subclasses`; `test/dist-identity.spec.ts: @Sensitive metadata crosses ESM and CJS copies` |
| SD-07 | MUST | `sensitiveFieldsOf(Class, prefix?)` returns the selectors of a decorated class, so plain payloads (JSON, gRPC loader objects) can use DTO marking. | G `@Sensitive()` on `Account.authToken`; W `sensitiveFieldsOf(Account, 'accounts[*]')`; T it returns `[{ path: 'accounts[*].authToken', mode: <default> }]` | `sensitiveFieldsOf turns decorator metadata into selectors` |
| SD-08 | MUST | Selectors support dot paths, `[*]`, `**` (zero or more levels) and quoted keys (`a["x.y"]`), match keys case-insensitively by default (`keyCase: 'sensitive'` opts out), compile once at boot, and fail boot with `SensitiveConfigError` naming the selector and the level when invalid. A bare name (`token`) matches the root key only. | G selectors `accounts[*].authToken`, `**.password`, `a["x.y"]` and `a..b`; W the module boots; T the first three match their fixtures and boot fails on `a..b` with the selector and level in the message | `selector grammar: dots, [*], **, quoted keys, case`; `invalid selector fails boot with level and selector` |
| SD-09 | MUST | A header denylist (default: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-xsrf-token`; case-insensitive; extendable, never shrinkable without `allow`) masks values in every headers object a sink writes: message headers, raw inbound headers, `OutboundHttpError.headers`. The idempotency key (message header `idempotencyKey`, raw headers `idempotency-key` and `x-idempotency-key`) is hashed when a `SaltProvider` exists and masked otherwise (hash-or-mask, SD-15). | G a message with custom header `authorization: Bearer X` and `idempotencyKey: K` (as the inbound mapper sets it), and a SaltProvider; W it passes a `.wireTap('audit', { redact: true })`; T the audit copy has `authorization: [REDACTED:header]` and `idempotencyKey: h:<id>:<hex>`; without a SaltProvider the key is `[REDACTED:header]` | `header denylist masks values case-insensitively`; `idempotency key header is hashed, or masked without a salt` |
| SD-10 | MUST | Protected trace fields (`id`, `traceId`, `spanId`, `parentSpanId`, `correlationId`, `causationId`, `timestamp`, `history[*]`) are never pattern-scanned or masked; a field rule that selects one fails boot. | G the `pii` pack and a `correlationId` that looks like a 16-digit card; W a hop error line is written; T the correlation id is printed intact; a rule on `headers.traceId` fails boot | `trace fields are never redacted`; `field rule on a protected trace field fails boot` |
| SD-11 | MUST | Pattern rules run after field rules on every string reached in a sink copy, at any depth: payload values, header values, `Error.message`, `Error.stack`, error own properties and the `cause` chain (within the walk limits of SD-22). | G a policy with a test rule, a payload with a nested string, and an error whose message, stack and `cause.message` each hold a token matched by the rule; W a saga afterCommit throws that error with a hop logger (S1) and a flow fails with it (S3); T none of the four occurrences remains in either line | `patterns redact nested strings, messages, stacks and causes` |
| SD-12 | MUST | Built-in packs `secrets@1` and `pii@1` (section 6.4) are opt-in by name (`'secrets'` means the latest version, `'secrets@1'` pins it); an unknown pack or version fails boot. A pack may hold field rules (key names) and pattern rules. The library ships no product-specific pack. | G `packs: ['secrets@1', 'pii']`; W boot; T both compile; `packs: ['acme']` fails boot naming the unknown pack | `pack resolution: pinned, latest, unknown`; `secrets pack positive and negative corpus`; `pii pack positive and negative corpus` |
| SD-13 | MUST | Built-in pack rules use only syntax that a linear (RE2-class) engine accepts: no lookaround, no backreferences. | G each built-in rule; W the RE2-syntax checker runs; T no rule is rejected | `built-in pack rules use RE2-compatible syntax only` |
| SD-14 | MUST | Modes behave as in section 6.3: `mask`, `remove`, `partial` (never reveals more than half the value; short values fall back to `mask`), `hash`, `length`, `replace`; modes that need a scalar fall back to `mask` on objects and arrays. | G one fixture per mode including a 6-char value under `partial` and an object under `hash`; W redacted; T outputs equal the table; the short value and the object are masked | `masking modes: one case per mode`; `partial never reveals more than half and masks short values` |
| SD-15 | MUST | `hash` is HMAC-SHA256 keyed by the current salt (at least 32 bytes) with output `h:<saltId>:<hex>` (16 hex chars by default, `hashChars` 12..64). A rule whose mode a user set to `hash` explicitly, with no `SaltProvider`, fails boot; there is no unsalted hash. Built-in rules (pack rules and the idempotency key header) use hash-or-mask: they hash with a salt and mask without one, which is never weaker. | G no `SaltProvider`; W boot with a user rule `{ mode: 'hash' }`; T `SensitiveConfigError` names the rule; with a 16-byte salt boot also fails; with `packs: ['pii']` and no salt boot passes and phones are masked | `hash requires a salt provider and a 32-byte salt`; `hash token is a keyed HMAC with the salt id`; `built-in hash-or-mask rules mask without a salt` |
| SD-16 | MUST | The salt is read at boot and on `SensitiveRuntime.rotateSalt()`; a failed refresh keeps the current salt and logs one warning without salt material; the salt is never printed. | G a provider that fails on refresh; W `rotateSalt()` runs; T tokens keep the old salt id and one warn line is logged, containing the salt id only | `failed salt refresh keeps the current salt and warns` |
| SD-17 | MUST | Levels go from outer to inner: module, channel, endpoint/binding/activator/saga, call. Field, header and pattern lists are unions. For the same path the stricter mode wins (`remove` > `mask` = `replace` > `length` > `hash` > `partial`); between two modes of equal strength the outer level's wins. An inner level cannot remove or weaken an outer rule except through `allow` (SD-18). **(amended)** The flow DSL adds the flow level (`FlowOptions.sensitive`, L3) and the step or target level (L4) inside the channel level, and inbound scopes add `InboundDefaults.sensitive` between module and channel; the full order per scope is in 6.6 and 18.2. | G module `mask` on `**.token` and endpoint `partial` on `token`; W the endpoint writes a sink; T `token` is masked; G module `replace: 'x'` and channel `mask` on the same path; T the output is `x` | `merge: unions, stricter mode wins, inner levels cannot weaken, ties keep the outer mode` |
| SD-18 | MUST | `allow: [{ path, mode?, reason }]` weakens or removes an outer rule for one path at one level and the levels inside it; `reason` is required (1..200 chars); every exception is logged at boot at warn level with level, path, mode and reason; an `allow` that matches no outer rule logs a warning. The allowed path's value is written with the allowed `mode` (or as-is when `mode` is undefined) and pattern rules skip it. | G an endpoint field rule `from` plus `allow: [{ path: 'from', mode: 'partial', reason: 'business sender number' }]` under `pii`; W boot, then a payload with `from: '+50212345678'` is written to S3; T one warn line with the four fields, and `from` is partial (`keepFirst`/`keepLast` of 6.3), not hashed by the pattern; the same entry without reason fails boot | `allow exceptions need a reason, are logged at boot and win over patterns` |
| SD-19 | MUST | With the default JavaScript engine, every pattern is validated at boot and rejected when it has nested unbounded quantifiers, a quantified alternation whose branches share a first character, adjacent unbounded quantifiers over overlapping sets, a backreference, the sticky flag, or can match a zero-length string at any position (decided on the parsed pattern, not by probing an empty input). A pattern without the `g` flag is recompiled with it. | G `(a+)+`, `(a\|ab)*`, `\d+\d+`, `(\w+)\1`, `/x/y`, `a*`, `\b`, `(?=x)`; W boot; T each fails boot with the pattern name and the reason; `/AKIA[0-9A-Z]{16}/` passes | `regex safety rejects catastrophic and zero-length patterns` |
| SD-20 | MAY | A `RegexEngine` port (for example an adapter over `re2`, injected by the app) compiles every rule; with it the backtracking analysis is skipped and syntax the engine rejects fails boot. Estela does not import `re2`. | G a fake engine that rejects lookbehind; W a user rule with lookbehind is compiled; T boot fails naming the rule | `regex engine port compiles every rule and reports rejects at boot` |
| SD-21 | MUST | A string longer than `maxScanBytes` (UTF-8, default 65536, range 1024..16777216) is cut in the sink copy: the first `maxScanBytes` (rounded down to a code point boundary) are scanned; then the copy drops the run of non-whitespace characters that reaches the cut, and at least the last 512 bytes of the window, and appends `[truncated N bytes]`. A secret straddling the cut is never partially emitted, whatever its length; a window with no whitespace is dropped whole. | G a 70 KiB string where a 2 KiB JWT starts 1 KiB before the 64 KiB mark; W written to S3; T no substring of the JWT longer than 8 chars appears and the marker reports the dropped size; G a 70 KiB base64 blob without whitespace; T the copy is the marker only | `long strings are cut after scanning, dropping the token that reaches the cut` |
| SD-22 | MUST | The walker stops at `maxDepth` (default 32) and `maxNodes` (default 10000) with `[TRUNCATED]`, writes `[Circular]` for cycles, never invokes getters (`[Getter]`) or `toJSON` (except `Date`, written as its ISO string), writes `[Binary len=N]` for `Buffer`/`Uint8Array`/`ArrayBuffer`, and walks `Map`/`Set` as entries/values. | G a payload with a cycle, a getter that throws, an object whose `toJSON` throws, a Buffer holding a secret, a `Date` and depth 40; W redacted; T no throw, no secret, the four placeholders appear and the date is an ISO string | `walker limits: depth, nodes, cycles, getters, toJSON, binary, Map and Set` |
| SD-23 | MUST | If redaction itself throws, the sink writes `[REDACTION_FAILED]` in place of the value, the business path continues, and one error line without data is logged (rate-limited to one per sink per minute). | G a selector compiler bug simulated by a throwing rule; W a sink writes; T the sink holds the placeholder and the flow completes | `redaction failure writes a placeholder, never the raw value` |
| SD-24 | MUST | False-positive policy. A pattern rule may declare `accept(match, input, offset)`, run in code after the regex matches; a rejected match is left as-is and the scan resumes after it. `pii.phone-e164` matches `\+[1-9]\d{7,14}` and its `accept` rejects a match preceded or followed by a digit; `pii.card` accepts only the issuer prefixes and lengths of section 6.4 with a valid Luhn check and no adjacent digit. Context is checked in code, never consumed by the regex, so adjacent values are all matched. Over-masking is accepted; each rule has `skipKeys`; protected trace fields are never scanned (SD-10). | G the strings `1731150000000`, `+05:30`, `+0000`, `+123`, `+5021234567890123456` (19 digits), a fixed list of 18- and 19-digit ids that each lack an issuer prefix or fail Luhn, and `call +50212345678 +50287654321`; W the `pii` pack runs; T only the two numbers in the last string are redacted, both of them | `pii false-positive corpus: timestamps, ids, offsets`; `adjacent phone numbers are both redacted` |
| SD-25 | MUST | The `pii` E.164 rule uses hash-or-mask (D-PHONE: customer numbers are hashed when a salt exists); apps keep `partial` for their own business/sender numbers through a field rule plus an `allow` with reason (SD-18). | G `pii` and a SaltProvider; W `+50212345678` appears in an error message; T it is written as `h:<id>:<hex>`; without a SaltProvider it is `[REDACTED:pii.phone-e164]` | `pii phone rule hashes by default` |
| SD-26 | MUST | Mask tokens name the rule that fired: `[REDACTED:<rule>]` (`header` for the denylist, `field` for unnamed field rules). Rule names come from configuration only and match `^[a-z0-9][a-z0-9._-]{0,63}$`. | G a rule named `My Rule!`; W boot; T boot fails; a rule `pii.email` produces `[REDACTED:pii.email]` | `mask tokens name the rule; invalid names fail boot` |
| SD-27 | MUST | Sinks S1, S2, S3, S5, S6, S7, S8, S9 (when the saga runner has a policy), S10 (when `redact: true`), S11, S12 and S14 apply the effective policy of their channel/endpoint/binding/activator/saga. **(amended)** S10 also applies it by default when an explicit policy reaches the tap (SD-52); flow sinks use the flow and step subjects of 18.2 (SD-45). | G every Estela entry and exit wired in one app with a policy, logging at debug; W the leak e2e drives success, failure, duplicate and replay paths; T `expectNoLeak` passes for all secrets in all forms | `test/sensitive-leak.e2e.spec.ts: no secret reaches any sink at debug level` |
| SD-28 | MUST | `wireTap(channel, { redact: true })` delivers a redacted copy (same `id`, copied history); without the option it keeps the 0.9.0 shared-payload copy. **(amended)** That default holds only while no explicit policy reaches the tap (module, tap channel, flow, step); when one does, the copy is redacted by default and `redact: false` needs `redactReason` (SD-52). | G a flow with `.wireTap('audit', { redact: true })`; W a message with a token passes; T the audit subscriber sees the mask and the main path sees the token | `wireTap redact delivers a redacted copy` |
| SD-29 | MUST | `storeMode` resolves per durable scope (inbound endpoint, activator, saga): an explicit value wins; otherwise `plain` when no explicit `sensitive` object reaches the scope (the baseline does not count) and `status-only` when one does (module level included). Sagas only get a policy through `SagaRunnerOptions.sensitive` (D7). Flow scopes have no `storeMode`: their records hold no payload (`{ completed }`/`{ filtered }`), and under a policy their failure records hold the redacted error. Boot logs one warn line per scope whose `storeMode` was defaulted to `status-only`. **(amended)** Only a resolved reference holding at least one rule counts as an explicit `sensitive` object; a module object that declares only `profiles`, providers or limits does not (SD-57). Flow step scopes have no `storeMode` either (SD-58). | G a module policy, an endpoint and an activator without `storeMode`; W boot and one request; T the record is status-only and boot logged one warn line for each of the two scopes; without the module policy the record is plain and no line is logged | `storeMode default: plain without policy, status-only with one, defaulted scopes listed at boot` |
| SD-30 | MUST | The interaction matrix in section 8.2 holds; a request/reply inbound with `onDuplicate: 'replay'` whose resolved `storeMode` is `status-only` fails boot, naming the endpoint. | G that endpoint; W boot; T `SensitiveConfigError` with the channel name; with `storeMode: 'encrypted'` boot passes | `status-only plus replay on request/reply fails boot`; one test per matrix row (section 10.1, group G) |
| SD-31 | MUST | `encrypted` seals records with AES-256-GCM (random 96-bit IV, key from `KeyProvider`, AAD = `estela:v1:<scope>::<key>`) into `{ estelaSealed: { v: 1, kid, iv, tag, ct } }`; a record that fails authentication (tampered, or copied to another key) raises a non-retryable `SensitiveRecordError` and is never re-run. | G a sealed record moved to another storage key; W a repeat reads it; T `SensitiveRecordError`, the handler is not called | `sealed records: round trip, tamper, key swap` |
| SD-32 | MUST | D-REDIS-DOWN applied to keys. For an `encrypted` scope Estela calls `KeyProvider.current()` before it claims the key (inbound `begin`, activator `begin`, before the saga's first unit) and seals with that key; when it fails, nothing is claimed or dispatched and the caller gets a retryable `SensitiveKeyUnavailableError`. When `byId()` throws on a repeat the request fails with the same retryable error and is not re-run; when `byId()` returns `undefined` it fails with a non-retryable `SensitiveReplayUnavailableError`. There is no fail-open setting for encrypted scopes (D-REDIS-DOWN, D13). | G a KeyProvider whose `current()` throws; W a new request with a key arrives; T the handler's channel receives nothing, the error is retryable and the store holds no record for the key | `key provider down at claim fails closed before dispatch`; `key provider down at replay never re-runs`; `retired key gives replay unavailable` |
| SD-33 | MUST | `SagaRunnerOptions.sensitive` sets the ledger `storeMode`. The data key is fetched before the first unit (SD-32), so no provider call runs inside a database transaction; sealing runs inside the unit's transaction before `record`. On a status-only replay the runner returns `replyOnReplay(ctx)` when given, else throws `SensitiveReplayUnavailableError`. | G a status-only saga without `replyOnReplay`; W the same key runs twice; T the second run throws it and no step runs; G an encrypted saga with a spy KeyProvider; T `current()` is called before `transactions.run` and never inside it | `saga ledger: encrypted round trip, key fetched outside the transaction`; `saga ledger: status-only replay` |
| SD-34 | MUST | An activator duplicate whose record is status-only and whose message has a reply channel sends no reply and logs one warn line with the scope (never the key). | G an activator scope with a status-only record; W a duplicate with `replyChannel` arrives; T no reply is sent and one warn line names the scope | `activator duplicate on a status-only record warns and does not reply` |
| SD-35 | MUST | The `IdempotencyStore` and `IdempotencyLedger` contracts are unchanged; sealed and status-only records survive a store that round-trips records through `JSON.stringify`/`JSON.parse`. | G a JSON-serializing fake store; W encrypted and status-only records are written and replayed; T replays work | `sealed and status-only records survive a JSON store` |
| SD-36 | MUST | Redaction is lazy: no walk, scan or hash runs unless a sink is about to write; with hop logging off and no failure, the redactor is never called. | G a module policy and `logging.hops: false`; W 1000 successful requests on a fire-and-forget endpoint (its records are `{ accepted, id }` and are never encoded, section 7.3); T the redactor spy records zero calls | `redactor is not called when no sink writes` |
| SD-37 | MUST | Boot validation collects every configuration problem and throws one `SensitiveConfigError` listing them; on success one info line per policy scope summarises it (scope, counts, pack versions, storeMode, salt id) with no rule bodies or data. **(amended)** Module and profile problems and every L2..L4 reference problem are reported together by the boot resolver (SD-55), and the error also carries structured `findings`; flow and step subjects get summary lines (SD-60). | G three independent config errors; W boot; T one error lists all three | `boot reports all configuration errors at once`; `boot summary line has no data` |
| SD-38 | MUST | `@estela/nest/testing` exports `captureSinks()` and `expectNoLeak()` (section 4.9). The corpus checks plain, base64 and base64url at the three byte alignments, `encodeURIComponent`, form encoding, JSON-escaped and double JSON-escaped forms; secrets shorter than 8 chars are refused; a failure names the sink, the form and a SHA-256 prefix of the secret, never the secret. | G a secret written base64-encoded at offset 1 inside a log line; W `expectNoLeak` runs; T it fails naming sink `log`, form `base64@1` and the hash prefix | `expectNoLeak finds every encoded form`; `expectNoLeak never prints the secret` |
| SD-39 | SHOULD | The module provides `SensitiveRuntime` as an injectable provider whose `redactForLog(value, { channel? })` and `redactError(error, { channel? })` use the compiled module policy, for app code (exception filters, app loggers). There is no process-global runtime: two modules in one process keep separate policies. | G an exception filter that injects `SensitiveRuntime`, and two test apps with different policies in one process; W an upstream error with a token is caught in each; T each filter's line is masked by its own app's policy | `SensitiveRuntime is injectable and scoped to its module` |
| SD-40 | MUST | No runtime dependency is added; `src/sensitive/` imports no npm package (new depcruise rule `sensitive-no-npm`, `node:` modules allowed); the domain files keep their rule; d.ts stays TS 4.9-parseable. | G the build; W `npm run verify`; T depcruise and `dist-typescript4` pass | depcruise `sensitive-no-npm`; `test/dist-typescript4.spec.ts` |
| SD-41 | SHOULD | Overhead is measured, not assumed: a benchmark (payload sizes, rule counts, packs, engines) is added under SPI-444, which sets the budgets. | G SPI-444; W the benchmark runs; T results are published and budgets recorded there | SPI-444 `bench/sensitive.bench.ts` |
| SD-42 | MUST | Salt and key material, rule bodies and allow-listed values are never written to any sink, including boot lines and `SensitiveConfigError` messages. | G a misconfigured 16-byte salt; W boot fails; T the error text holds the salt id and length, not the bytes | `config errors and boot lines never print salt or key material` |
| SD-43 | MUST | Estela's own errors keep idempotency keys out of `message`: `IdempotencyInProgressError.message` is `IDEMPOTENCY_KEY_IN_PROGRESS: <scope>`. Their key-bearing own properties (`IdempotencyInProgressError.key`, `InboundIdempotencyInFlightError.clientKey`) are written by every sink with the idempotency-key treatment of SD-09 (hash-or-mask), baseline included. | G a saga run from an activator with a key `K-555` whose first run is in progress; W the duplicate throws and reaches error.channel; T `message` and the S3 line hold no `K-555`, and `error.key` on the thrown error is still `K-555` | `in-progress errors keep the key out of message and sinks` |
| SD-44 | MUST | Inbound endpoints that boot discovery skips (`integration.module.ts:347-350` logs and continues) are validated when their plan is built at the first request: a configuration problem there throws `SensitiveConfigError` for that request, before any claim, and is logged once per endpoint. | G an endpoint whose policy has an invalid selector and whose discovery is made to fail; W its first request arrives; T the request fails with `SensitiveConfigError`, nothing is claimed, and a second request fails the same way with no second log line | `inbound policy missed by discovery is validated at first plan build` |

Requirements SD-45 to SD-67 (flow DSL, profiles, channel and endpoint references, graph and boot
observability) are in section 18.4, with the same columns.

## 4. Public API by file

All new code sits in `src/sensitive/` and imports only `node:crypto` and sibling files. Comments are
English and ASCII-only (`npm run comments:en`).

### 4.1 `sensitive/sensitive.types.ts` (new)

```ts
export type MaskMode = 'mask' | 'remove' | 'partial' | 'hash' | 'length' | 'replace';

export interface MaskOptions {
  mode?: MaskMode;            // default 'mask'
  keepFirst?: number;         // partial; default 0
  keepLast?: number;          // partial; default 4
  replace?: string;           // replace; literal output
}

export interface FieldRule extends MaskOptions {
  /** Selector (section 6.1). */
  path: string;
  /** Rule name used in mask tokens; default 'field'. */
  name?: string;
}

export interface PatternRule extends MaskOptions {
  name: string;               // ^[a-z0-9][a-z0-9._-]{0,63}$
  regex: RegExp;
  /** Capture group to redact; default 0 (the whole match). */
  group?: number;
  /** Selectors whose values this rule never scans. */
  skipKeys?: readonly string[];
  /** Runs after a regex match; false leaves the match as-is (context and checksum checks, SD-24). */
  accept?: (match: string, input: string, offset: number) => boolean;
}

export type PackName = 'secrets' | 'pii' | `secrets@${number}` | `pii@${number}`;

export interface AllowException {
  path: string;
  /** Mode allowed at this level; undefined means "no redaction" for this path. */
  mode?: MaskMode;
  reason: string;             // 1..200 chars, logged at boot
}

export type StoreMode = 'plain' | 'redacted' | 'encrypted' | 'status-only';

/** What a channel, endpoint, binding, activator, saga or call declares. */
export interface SensitivePolicy {
  fields?: readonly (string | FieldRule)[];   // a string is { path, mode: default }
  headers?: readonly string[];                // added to the denylist
  patterns?: readonly PatternRule[];
  packs?: readonly PackName[];
  allow?: readonly AllowException[];
  /** Durable scopes only (inbound, activator, saga). */
  storeMode?: StoreMode;
  /** Required when storeMode is 'plain' under an effective policy; logged at boot. */
  storeModeReason?: string;
  defaultMode?: MaskMode;                     // default 'mask'
  keyCase?: 'insensitive' | 'sensitive';      // default 'insensitive'
}

/** Module-wide options: `forRoot({ sensitive })`. `false` disables the baseline (section 2). */
export interface SensitiveModuleOptions extends SensitivePolicy {
  salt?: SaltProvider;
  keys?: KeyProvider;
  regexEngine?: RegexEngine;
  maxScanBytes?: number;      // default 65536 (provisional, revisited in SPI-444)
  maxDepth?: number;          // default 32
  maxNodes?: number;          // default 10000
  hashChars?: number;         // default 16, range 12..64
}
```

**(amended) Profiles and references (section 18, shared flow parameter model section 2):**

```ts
/** Profile names: ^[a-z0-9][a-z0-9._-]{0,63}$ (the grammar of PatternRule.name). */
export type ProfileName = string;

export interface NamedSensitivePolicy extends SensitivePolicy {
  extends?: ProfileName | readonly ProfileName[];
}

// SensitiveModuleOptions gains (optional, additive):
//   profiles?: Readonly<Record<ProfileName, NamedSensitivePolicy>>;

/** What L2..L5 accept wherever a SensitivePolicy was accepted before. */
export type SensitiveRef =
  | ProfileName
  | readonly ProfileName[]
  | (SensitivePolicy & {
      use?: ProfileName | readonly ProfileName[];
      /** 'sinks' (default) | 'mask-payload' (L4 flow steps only, SD-50). */
      apply?: 'sinks' | 'mask-payload';
      applyReason?: string;          // required with 'mask-payload', logged at boot
    });
```

### 4.2 `sensitive/sensitive.decorator.ts` (new)

```ts
export function Sensitive(options?: MaskOptions & { name?: string }): PropertyDecorator;
/** Selectors of a decorated class, prefixed (e.g. 'accounts[*]'). Own and inherited fields. */
export function sensitiveFieldsOf(type: abstract new (...args: never[]) => unknown, prefix?: string): FieldRule[];
```

Metadata is kept on the constructor under `Symbol.for('@estela/nest.sensitive')` (non-enumerable),
so two copies of the package share it (the same reason as the saga error brand, D25 of the saga
spec). No `reflect-metadata`.

### 4.3 `sensitive/salt-provider.ts`, `sensitive/key-provider.ts` (new ports)

```ts
export interface SaltMaterial { id: string; secret: Uint8Array }     // id ^[A-Za-z0-9_-]{1,16}$, secret >= 32 bytes
export interface SaltProvider { current(): SaltMaterial | Promise<SaltMaterial> }
/** Reads base64 from an env var; id from a second var. Throws at boot when missing or short. */
export function envSaltProvider(secretVar: string, idVar: string, env?: Record<string, string | undefined>): SaltProvider;

export interface DataKey { id: string; key: Uint8Array }            // 32 bytes (AES-256)
export interface KeyProvider {
  /** Key for new records. Implementations cache; Estela calls it once per sealed write. */
  current(): Promise<DataKey>;
  /** Key of an existing record; undefined when retired. */
  byId(id: string): Promise<DataKey | undefined>;
}
```

`KeyProvider` implementations SHOULD NOT retry internally; a failure surfaces as the retryable error of
SD-32 and the caller's retry layer decides (SPI-445: RS-17a classifies it `'transient'`, RS-28 to
RS-31 own the budget).

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

### 4.5 `sensitive/redactor.ts` (new)

```ts
export type SinkKind = 'log' | 'store' | 'ledger' | 'wiretap' | 'error-envelope' | 'capture';
export interface RedactContext { sink: SinkKind; channel?: string; scope?: string }
export class SensitiveRuntime {
  /** Compiled at module init. (amended) Returns its problems to the boot resolver, which throws
   *  one SensitiveConfigError with every finding (7.1, SD-55). */
  static compile(options: SensitiveModuleOptions | false | undefined, scopes: ScopePolicies): Promise<SensitiveRuntime>;
  redact<T>(value: T, ctx: RedactContext): unknown;
  redactError(error: unknown, ctx: RedactContext): { name: string; message: string; stack?: string; [k: string]: unknown };
  redactText(text: string, ctx: RedactContext): string;
  storeModeOf(scope: string): StoreMode;
  rotateSalt(): Promise<void>;
  /** For app code (SD-39): the module policy, sink kind 'log'. */
  redactForLog(value: unknown, ctx?: { channel?: string }): unknown;
  /** (amended, SD-61) Counters by rule, sink kind and subject; never values. */
  stats(): { byRule: Record<string, number>; bySink: Record<string, number>; bySubject: Record<string, number>; redactionFailed: number; maskFailed: number };
}
```

`SensitiveRuntime` is a Nest provider of the module (exported like `ChannelRegistry`); there is no
process-global instance (SD-39). Its `redactError(error, ctx)` is the same method the sinks use.

### 4.6 `sensitive/sealed-record.ts` (new)

```ts
export const SEALED_RECORD_KEY = 'estelaSealed';
export const STATUS_ONLY_RECORD_KEY = 'estelaStatusOnly';
export interface RecordCodec {
  readonly storeMode: StoreMode;
  /** Called before the claim. Encrypted: fetches KeyProvider.current() (SD-32); others: no I/O. */
  prepare(): Promise<RecordSealer>;
  /** Inverse on read; status-only yields { statusOnly: true }. byId() failures per SD-32. */
  decode(scope: string, key: string, stored: Record<string, unknown>): Promise<Record<string, unknown> | { statusOnly: true }>;
}
/** Holds the data key fetched by prepare(); encode is CPU-only (safe inside a transaction). */
export interface RecordSealer {
  encode(scope: string, key: string, record: Record<string, unknown>): Record<string, unknown>;
}
```

The codec sits above the store, in the inbound gate, the activator wrapper and the saga runner, not in
the store (D13). It does not use a store-level codec: the hook first drafted for SPI-429
(MR-20) is retired in the MR spec (its D17), because that hook is synchronous, does not receive `scope`/`key` (needed for the AAD of SD-31), and
is absent from `MemoryIdempotencyStore` and existing custom stores.

### 4.7 `sensitive/sensitive-errors.ts` (new)

```ts
export class SensitiveConfigError extends Error { readonly problems: readonly string[] }
export class SensitiveKeyUnavailableError extends Error { readonly retryable = true; readonly code = 'SENSITIVE_KEY_UNAVAILABLE' }
export class SensitiveReplayUnavailableError extends Error { readonly retryable = false; readonly code = 'REPLAY_UNAVAILABLE' }
export class SensitiveRecordError extends Error { readonly retryable = false; readonly code = 'SENSITIVE_RECORD_INVALID' }
// (amended, section 18)
export interface SensitiveFinding {
  code: string;               // e.g. UNKNOWN_PROFILE, PROFILE_CYCLE, MASK_PAYLOAD_LEVEL
  severity: 'error' | 'warning';
  subject: string;            // e.g. "flow 'loan' step 'credit'", "channel 'payments.charge'"
  path: string;               // option path, e.g. "sensitive.use"
}
// SensitiveConfigError gains: readonly findings: readonly SensitiveFinding[]  (problems stays)
// (amended, cross-spec) when concerns mix, each SensitiveFinding is carried in FlowDefinitionError as a
// FlowParameterFinding (RS 3.10) with concern 'sensitive' and a names-only message (RS-67, SD-55)
export class SensitiveMaskError extends Error { readonly retryable = false; readonly code = 'SENSITIVE_MASK_FAILED' }
```

Messages hold scope and channel names only, never keys or values. `SensitiveKeyUnavailableError` is
raised before any claim (SD-32), so there is no key to release; it never reaches the `onFailure`
policy. Errors carry `retryable` for the caller's retry layer; no Estela layer retries them.

### 4.8 Changed files (all additive)

| File | Change |
|---|---|
| `integration.module.ts` | `IntegrationModuleOptions.sensitive?: SensitiveModuleOptions \| false`; compiles `SensitiveRuntime` in `onModuleInit` before channels; error.channel logger uses `redactError`/`redact` (SD-04); explorer `onError` uses `redactText`; provides and exports `SensitiveRuntime` (SD-39) |
| `trace/hop-logger.ts` | `constructor(level?, redactor?: SensitiveRuntime)`; `hopError` writes redacted name, message and stack (its only caller is `SagaTracer.error`; the module passes the runtime to the hop logger it builds, `integration.module.ts:101-104`; a saga runner gets the runtime through `SagaRunnerOptions.sensitive.runtime`) |
| `saga/saga-tracer.ts` | fallback line redacted through the runner's runtime |
| `channel-factory.ts` | `ChannelSpec.sensitive?: SensitivePolicy` **(amended)**: `SensitiveRef` |
| `inbound/inbound.types.ts` | `InboundSpec.sensitive?`; `InboundIdempotencyOptions.storeMode?: StoreMode`; **(amended)** both `InboundSpec.sensitive` and the new `InboundDefaults.sensitive` are `SensitiveRef` |
| `inbound/inbound.idempotency.ts` | `InboundIdempotencyPlan.codec` gains `records: RecordCodec`; `claim` calls `prepare()`; `succeed`/`settle` encode; repeats decode (section 7.3) |
| `inbound/inbound.failure.ts` | `statusOnlyFailure(serialized)` keeps `{ kind, status }` or `{ kind, name }`; `clientKey` of `InboundIdempotencyInFlightError` declared key-bearing (SD-43) |
| `saga/idempotency-ledger.ts` | `IdempotencyInProgressError.message` without the key; `key` declared key-bearing (SD-43) |
| `decorators.ts` | `ActivatorOptions.sensitive?: SensitivePolicy` **(amended)**: `SensitiveRef` |
| `activator/activator-wrapper.ts` | records through `RecordCodec`; SD-34 warning |
| `flow/flow-executor.ts` | stored failure redacted; error envelope `error` redacted when a policy applies (raw only with `sensitive: false`) |
| `flow/integration-flow.ts`, `flow/steps/wire-tap.step.ts` | `wireTap(channel, options?: { redact?: boolean })` **(amended)**: `wireTap(channel, opts?: StepCommonOptions & { redact?: boolean; redactReason?: string })`; `from(source, options?: FlowOptions)`; `StepCommonOptions` (`id`, `sensitive`) on every step except `reply`, which takes `id` only (section 18.3) |
| `flow/flow-step.ts`, `flow/steps/*.ts` **(amended)** | `FlowTarget extends FanoutTargetInput` with `sensitive?`; steps keep their resolved plan; `describe()` adds the `sensitive` key only when set (SD-59, SD-65) and the `id` key by the rule of RS-66 shared by the three specs (Q17) **(amended, cross-spec)** |
| `flow/flow-executor.ts` **(amended)** | the error envelope and the stored failure use the policy of the failing step's subject (SD-45) |
| `graph/channel-graph.ts` **(amended)** | `sensitive?: string[]` on `GraphNode`, `GraphInboundRef`, `GraphOutboundRef`, `GraphFlowEntry.options` and step dests; `profiles` in `GraphSnapshot.module` when declared (SD-59) |
| `adapters/grpc.adapter.ts` **(amended)** | `bindGrpcOut(..., options?: { replyChannel?; id?; resilience?; sensitive?: SensitiveRef })` (shape only; engine wired by SPI-430) |
| `outbound/outbound.types.ts` | `OutboundRestOptions.sensitive?: SensitivePolicy` (module defaults and bindings) and `OutboundRestCallOptions.sensitive?: SensitivePolicy` (call level) **(amended)**: both `SensitiveRef`; call-level names validated at first call (SD-56) |
| `adapters/rest.adapter.ts` | message uses `redactUrl` (SD-05) |
| `saga/saga-runner.ts` | **(amended)** `policy` is `SensitiveRef`; names resolve only with `runtime` (SD-63). `SagaRunnerOptions.sensitive?: { policy?: SensitivePolicy; storeMode?: StoreMode; keys?: KeyProvider; runtime?: SensitiveRuntime; replyOnReplay?: (ctx: unknown) => unknown }` |
| `index.ts` | exports the new public symbols (no npm imports added) |

### 4.9 Testing subpath (`src/testing/`)

```ts
export interface CapturedWrite { sink: SinkKind; where: string; text: string }
export interface SinkCapture {
  readonly writes: readonly CapturedWrite[];
  /** Nest LoggerService to pass to Logger.overrideLogger / app.useLogger. */
  readonly logger: LoggerService;
  store(inner: IdempotencyStore): IdempotencyStore;          // records what is written
  ledger<Tx>(inner: IdempotencyLedger<Tx>): IdempotencyLedger<Tx>;
  channel(registry: ChannelRegistry, name: string): Unsubscribe;
  /** Test-only: also record pre-redaction values; expectNoLeak refuses such a capture. */
  readonly unsafeRaw: boolean;
}
export function captureSinks(options?: { unsafeRaw?: boolean }): SinkCapture;
export function expectNoLeak(capture: SinkCapture, secrets: readonly string[], options?: { forms?: readonly LeakForm[] }): void;
export type LeakForm = 'plain' | 'base64@0' | 'base64@1' | 'base64@2' | 'base64url@0' | 'base64url@1' | 'base64url@2' | 'uri' | 'form' | 'json' | 'json2';
export function leakForms(secret: string): ReadonlyMap<LeakForm, string>;
```

`src/testing/` keeps its depcruise rule (no import from `src/inbound/` or `src/adapters/`).

## 5. File layout

```
src/sensitive/sensitive.types.ts      policy and option types
src/sensitive/sensitive.decorator.ts  @Sensitive, sensitiveFieldsOf (global-symbol metadata)
src/sensitive/selector.ts             parse + compile selectors (section 6.1)
src/sensitive/policy-resolver.ts      levels, merge, allow, storeMode resolution, boot validation
src/sensitive/packs.ts                secrets@1, pii@1
src/sensitive/regex-safety.ts         boot analysis (SD-19), RE2-syntax checker (SD-13)
src/sensitive/regex-engine.ts         RegexEngine port, nativeRegexEngine
src/sensitive/masking.ts              modes, HMAC, Luhn
src/sensitive/redactor.ts             SensitiveRuntime, walker, limits, copy-on-write
src/sensitive/sealed-record.ts        RecordCodec: plain, redacted, encrypted, status-only
src/sensitive/salt-provider.ts        SaltProvider port, envSaltProvider
src/sensitive/key-provider.ts         KeyProvider port
src/sensitive/sensitive-errors.ts
src/sensitive/**/*.spec.ts
src/testing/capture-sinks.ts, expect-no-leak.ts, leak-forms.ts (+ testing/index.ts exports)
test/sensitive-leak.e2e.spec.ts       HTTP loopback app, every sink, debug level
test/dist-identity.spec.ts            (extended) decorator metadata across ESM/CJS (skipped until built)
docs/ESTELA_SENSITIVE_DATA_SPEC.md    this file
```

Repo rules: eslint `complexity` 12 and cognitive complexity 15 (the walker is split per value kind);
new depcruise rule `sensitive-no-npm` (`^src/sensitive/` may import only `node:` modules and siblings);
no new runtime or peer dependency; `re2` is never imported by Estela.

## 6. Behaviour

### 6.1 Selector grammar

```
selector := segment ('.' segment | '[*]' | '["' key '"]')*
segment  := '**' | '*' | key
```

- `*` matches one key, `[*]` every array element, `**` zero or more levels (objects and arrays).
- Keys compare case-insensitively unless `keyCase: 'sensitive'`; header names always compare
  case-insensitively.
- A bare name matches the root key only (`token` is not `**.token`).
- Compiled into a trie once at boot; matching is O(path depth x rules at that node).

### 6.2 Order of application for one sink copy

1. Walk limits (SD-22) and protected trace fields (SD-10) are set.
2. Field rules (decorator metadata of class instances, selectors, header denylist) replace matched
   values by mode.
3. Pattern rules scan every remaining string (after the `maxScanBytes` cut, SD-21), skipping
   `skipKeys`, `allow`-listed paths (SD-18) and protected fields; a match is replaced only when the
   rule's `accept` returns true (SD-24).
4. Unchanged subtrees are shared with the input (copy-on-write); changed nodes are new objects.

### 6.3 Modes

| Mode | Scalar output | Object/array | Notes |
|---|---|---|---|
| `mask` (default) | `[REDACTED:<rule>]` | same token | |
| `remove` | key omitted; array element omitted | same | |
| `partial` | `+502***427` (`keepFirst`, `***`, `keepLast`) | falls back to `mask` | if `keepFirst + keepLast > floor(len / 2)` both shrink to fit; values under 8 chars are masked |
| `hash` | `h:<saltId>:<hex>` | falls back to `mask` | HMAC-SHA256(salt, UTF-8 value), first `hashChars` hex. Built-in rules use hash-or-mask: `mask` when no salt is configured (SD-15) |
| `length` | `[REDACTED:<rule> len=<n>]` | `[REDACTED:<rule> len=<entries>]` | n in UTF-16 code units |
| `replace` | the literal `replace` string | same | |

Numbers and bigints are stringified before `partial`/`hash`/`length`.

### 6.4 Built-in packs (version 1)

All rules use only RE2-compatible syntax (SD-13); context characters are captured and kept through
`group`.

| Pack | Rule | Matches | Mode |
|---|---|---|---|
| `secrets@1` | `secrets.keys` (field rules) | values of keys named `password`, `passwd`, `secret`, `token`, `access_token`/`accessToken`, `refresh_token`/`refreshToken`, `api_key`/`apiKey`/`api-key`, `client_secret`/`clientSecret`, `private_key`/`privateKey`, `authorization`, at any depth (`**.`), case-insensitive | mask |
| | `secrets.jwt` | `eyJ` header, `.`, `eyJ` payload, `.`, signature (base64url) | mask |
| | `secrets.bearer` | `Bearer <token>` (case-insensitive scheme) | mask (group: token) |
| | `secrets.basic-url` | userinfo in `scheme://user:pass@` | mask (group: userinfo) |
| | `secrets.aws-key-id` | `AKIA`/`ASIA` + 16 upper alphanumerics | mask |
| | `secrets.query` | value of `api_key`, `apikey`, `api-key`, `access_token`, `token`, `secret`, `password`, `sig`, `signature` query/form parameters | mask (group: value) |
| | `secrets.assignment` | `password`/`passwd`/`secret`/`api_key`/`token` followed by `:` or `=` and a value of 4+ chars, in free text and serialized JSON | mask (group: value) |
| | `secrets.pem` | PEM `PRIVATE KEY` block, terminated or running to the end of the scanned window | mask |
| `pii@1` | `pii.email` | RFC 5322 subset, linear form | hash-or-mask |
| | `pii.phone-e164` | regex `\+[1-9]\d{7,14}`; `accept` rejects a digit right before or after the match | hash-or-mask (D-PHONE) |
| | `pii.card` | digit groups (spaces or dashes allowed) whose digits form Visa (`4`, 13/16/19), Mastercard (`51`-`55`, `2221`-`2720`, 16), Amex (`34`, `37`, 15) or Discover (`6011`, `644`-`649`, `65`, 16/19); `accept` checks prefix, length, Luhn and no adjacent digit. Maestro and UATP are left out on purpose (their prefixes and lengths overlap common numeric ids) | partial, keepLast 4 |

Known false negatives (risk R1): phone numbers written with spaces, dashes or parentheses, or without
the leading `+`, are not matched by `pii.phone-e164`; field marking is the control for them.

Changing a rule in a way that changes what it matches bumps the pack version (`secrets@2`); `'secrets'`
follows the latest version of the installed release. The baseline (D3) is pinned to `secrets@1`.

### 6.5 Regex safety analysis (JavaScript engine)

The analyzer parses the pattern source into a small AST (groups, alternation, classes, escapes,
quantifiers) and rejects, with the reason in `SensitiveConfigError`:

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
| inbound endpoint `inbound:<channel>` | module, channel, `InboundSpec.sensitive` **(amended)**: module, `InboundDefaults.sensitive` (part of L1), channel, `InboundSpec.sensitive` |
| activator `activator:<Class>.<method>` | module, channel, `ActivatorOptions.sensitive` |
| flow `flow:<name>` | module, source channel **(amended)**: module, source channel, `FlowOptions.sensitive` (L3), then the failing step's subject levels (L4 step and target, plus the destination channel of a send step) for the error envelope and the stored failure (SD-45) |
| flow step `flow:<name>#<stepId>` **(new)** | module, source channel, destination channel (send steps only, SD-45), flow, step `sensitive`, target `sensitive` (fanout and jump targets) |
| wire-tap copy **(new)** | module, tap channel, source channel, flow, step (SD-52) |
| `headers.jumpReplies[<ch>]` in any sink copy **(new)** | the writing subject's levels, plus channel `<ch>` and that jump target's `sensitive` (SD-53) |
| outbound REST binding / call | module, channel (if bound), binding (`OutboundRestOptions.sensitive`, module defaults first), call (`OutboundRestCallOptions.sensitive`) |
| saga | `SagaRunnerOptions.sensitive.policy` (plus the runtime's module policy when `runtime` is passed) |
| hop line of a channel | module, channel |

Merge (SD-17): the table lists levels from outer (first) to inner (last). Unions of fields,
headers, patterns and packs; per path the stricter mode wins, ties keep the outer level's mode;
`allow` at a level applies to that level and the levels inside it and is the only way to weaken. `storeMode` is
taken from the most specific level that sets it, then SD-29. Setting `storeMode: 'plain'` on a
scope that has an effective policy requires `storeModeReason` (1..200 chars) in the same object; it
is logged at boot like an `allow` exception, and its absence fails boot.

## 7. Algorithms

### 7.1 Boot (`IntegrationRuntime.onModuleInit`, before channels are created)

```text
compile(options, scopes):
  if options === false: runtime = disabled (0.9.0 log text, SD-04/05 still apply)
  problems = []
  salt   = options.salt ? await salt.current() : undefined           // validate id, >= 32 bytes
  engine = options.regexEngine ?? nativeRegexEngine
  for each scope (module, channels, endpoints, bindings, activators):
    parse selectors (SD-08), resolve packs (SD-12), validate names (SD-26)
    for each pattern: engine === native ? analyze (SD-19) : engine.compile (SD-20)
    reject explicit hash without salt (SD-15), encrypted without keys, status-only + replay on
    request/reply (SD-30), allow without reason (SD-18), rules on protected fields (SD-10)
    built-in hash-or-mask rules resolve to hash (salt) or mask (no salt)
  if problems: throw SensitiveConfigError(problems)      // SD-37, no material printed (SD-42)
  log one summary line per scope; one warn line per allow exception and per defaulted
  status-only scope (SD-29)
```

**(amended)** `compile` still runs before channels are created but no longer throws on its own: it hands its problems to the boot
`FlowParameterResolver` (shared flow parameter model 5.2), which runs in `onModuleInit` after channels
are created (step 1, `integration.module.ts:248-258`) and before activators subscribe (step 2,
`:260-263`) and flows attach (step 3, `:265-281`). Because activator discovery (`:261`) and inbound discovery (`:262`) run in step 2 today, the resolver runs both discovery scans itself (the same `DiscoveryService` sources) before step 2, so activator and `InboundSpec` references are resolved before any subscription. It resolves every L2..L4 `SensitiveRef`, freezes one
plan per subject, and throws one `SensitiveConfigError` holding every sensitive finding (SD-55), or the
RS-67 class when findings of other concerns are present.
Running it before step 2 matters for this spec: activator references (`ActivatorOptions.sensitive`)
must be resolved before the first activator subscribes, so when it throws no activator or flow is
subscribed.

Inbound endpoints are found by the boot discovery (`integration.module.ts:347-360`). An endpoint that
discovery skipped is compiled when the planner first builds its plan (`inbound/inbound.plan.ts:273-282`)
and fails that request with `SensitiveConfigError` (SD-44).

### 7.2 Sink write

```text
write(sink, value, ctx):
  if runtime disabled or sink not enabled: write as 0.9.0 (or skip); return     // SD-36
  try: copy = redact(value, ctx)            // 6.2
  catch: copy = '[REDACTION_FAILED]'; rateLimitedError(sink)                   // SD-23
  sink.write(copy)
```

### 7.3 Durable records (inbound gate, activator, saga ledger)

```text
claim:    sealer = await records.prepare()  // encrypted: KeyProvider.current(); throws -> SD-32
                                              // (nothing claimed yet, retryable, no dispatch)
          begin(...) as today
succeed:  stored = sealer.encode(scope, key, record)   // plain: record; redacted: redact(record);
          store.complete(scope, key, stored)           // encrypted: seal; status-only: marker + ids
                                                       // a throw here = today's failing complete
repeat:   raw = store.get(...); rec = await records.decode(...)   // byId failure -> SD-32
          rec.statusOnly ? section 8.2 row : today's completedRepeat(rec)
failed:   keep    -> store.fail(scope, key, redactError(error))     (plain: raw error, as today)
          store   -> encode(wrapStoredFailure(codecFor(storeMode).serialize(error)))
          release -> as today
```

`{ accepted: true, id }` records hold only a generated message id and are stored as-is in every mode.
`fail` (the `keep` row) receives an `Error` whose `name` and `message` are the redacted ones (status-only:
`name`, with `message` set to `code` or empty), never the plain object `redactError` returns, so the
`serializeError` floor of the shipped SPI-429 stores (MR-08) stores `{ name, message }` and never wraps the
copy in `{ value }`.
The saga runner calls `prepare()` once per `run()`, before the first unit, and seals inside the
unit's transaction with the returned sealer (SD-33). Flow scopes have no codec: under a policy
`flow-executor.ts:80` writes `redactError(error)` instead of the raw error (SD-29).

### 7.4 Invariants (each has a unit test)

- **I1.** The input of a redaction is never mutated; delivered messages and thrown errors are the
  originals (SD-02).
- **I2.** No sink receives a value that skipped redaction while a policy or the baseline is active:
  every write goes through `SensitiveRuntime` or the disabled path (SD-23, SD-27). **(amended)** The
  documented exceptions are a tap reached by no explicit policy without `redact: true` (SD-28) and
  a tap with `redact: false` plus a logged `redactReason` (SD-52).
- **I3.** A sealed record decrypts only under its own `scope::key` (AAD) and key id (SD-31).
- **I4.** A repeat never re-runs the handler because of a sensitive failure (decrypt, key, status-only)
  (SD-31, SD-32, SD-33).
- **I5.** An inner level never weakens an outer rule except through a logged `allow` (SD-17, SD-18).
- **I6.** Hashing never runs without a salt of at least 32 bytes (SD-15).
- **I7.** Protected trace fields are byte-identical in every sink (SD-10).
- **I8.** Boot fails on any invalid security configuration; there is no warn-and-continue (SD-37).
  The one exception is an inbound endpoint that discovery skipped: it fails its requests instead
  (SD-44).
- **I9.** No provider I/O (`KeyProvider`, `SaltProvider`) runs inside a saga unit's transaction (SD-33).

## 8. Failure and interaction matrix

### 8.1 Failures

| Situation | Behaviour | Retryable | Requirement |
|---|---|---|---|
| Invalid selector, pack, rule name, unsafe regex, empty-matching regex | boot fails, all problems listed | n/a | SD-08, SD-12, SD-19, SD-26, SD-37 |
| explicit `hash` rule, no `SaltProvider`; any salt under 32 bytes | boot fails | n/a | SD-15 |
| built-in hash-or-mask rule, no `SaltProvider` | masks instead of hashing | n/a | SD-15 |
| `encrypted` resolved, no `KeyProvider` | boot fails | n/a | SD-31 |
| status-only + request/reply + `onDuplicate: 'replay'` | boot fails | n/a | SD-30 |
| `storeMode: 'plain'` under an effective policy without `storeModeReason`; `allow` without reason | boot fails | n/a | SD-18, SD-29 |
| `SaltProvider` fails at boot | boot fails | n/a | SD-15 |
| `SaltProvider` fails on `rotateSalt()` | keep current salt, one warn | n/a | SD-16 |
| `KeyProvider.current()` fails before the claim | nothing claimed, no dispatch; `SensitiveKeyUnavailableError` | yes | SD-32 |
| sealing throws at `succeed` (the key was fetched before the claim, so no provider I/O happens here) | as today's failing `complete` (`inbound.idempotency.ts:231-240`): `fail` is written with the redacted error, the key stays blocked until TTL, the error reaches the caller | yes, with the same key (the work ran) | SD-32 |
| `byId()` throws on repeat | `SensitiveKeyUnavailableError`, no re-run | yes | SD-32 |
| `byId()` returns undefined (retired key) | `SensitiveReplayUnavailableError`, no re-run | no | SD-32 |
| sealed record fails authentication | `SensitiveRecordError`, no re-run | no | SD-31 |
| redactor throws | `[REDACTION_FAILED]`, flow continues | n/a | SD-23 |
| string above `maxScanBytes` | cut with tail guard | n/a | SD-21 |
| inbound endpoint skipped by discovery has an invalid policy | that request fails with `SensitiveConfigError` before the claim | no | SD-44 |
| idempotency store (Redis) unavailable | unchanged by this ticket: SPI-429 owns it (D-REDIS-DOWN: `IdempotencyStoreUnavailableError`, always fail-closed for `ChannelSpec.sideEffects: true`, configurable with fail-closed default otherwise); `storeMode` adds no fallback and `prepare()` runs before `begin`, so a key-provider failure and a store failure never both happen on one claim | per SPI-429 | n/a |

This ticket adds no retry loop and reads or spends no retry budget. Retryable errors carry
`retryable: true`; SPI-445 decides which layer retries (RS-17a, RS-28) and how the budget propagates
(RS-29 to RS-31).
`KeyProvider` and `SaltProvider` implementations SHOULD NOT retry internally (4.3), so a caller's
retry is the only one.

### 8.2 `storeMode` against inbound idempotency and saga replay

| storeMode | Record on request/reply success | Repeat, `onDuplicate: 'envelope'` (`result` field) | Repeat, `onDuplicate: 'replay'` | `onFailure: 'store'` | `onFailure: 'keep'` (`fail` record) | Activator duplicate | Saga ledger replay |
|---|---|---|---|---|---|---|---|
| `plain` | `{ cachedResult }` as today | cached result (today, `inbound.idempotency.ts:183`) | reply as the first time | codec output as today | raw error as today | re-sends cached result | stored reply |
| `redacted` | `{ cachedResult: redact(result) }` | redacted result | redacted reply (explicit opt-in only, never a default: replaying `[REDACTED]` as data is silent corruption, D6) | serialized, then redacted | redacted serialized error | re-sends redacted result | redacted reply |
| `encrypted` | sealed `{ cachedResult }` | decrypted result | decrypted reply | sealed serialized failure; replay rethrows the original status and body | redacted serialized error (failed records are never replayed) | decrypts and re-sends | decrypted inside the claim transaction |
| `status-only` | `{ estelaStatusOnly: { v: 1 } }` | `result: null` | request/reply: boot error (SD-30); fire-and-forget: accepted replay works (ids only) | `{ kind: 'http', status }` or `{ kind: 'error', name }`; replay rethrows the status with a generic body | `{ name, code? }` | no reply, warn (SD-34) | `replyOnReplay(ctx)` or `SensitiveReplayUnavailableError` (SD-33) |
| any | `{ accepted: true, id }` for fire-and-forget, unchanged | | | | | | |

`onFailure: 'release'` writes nothing in every mode. `onInFlight` is unaffected (no body is read).
Flow scopes are not in this table: they have no `storeMode` (SD-29).

## 9. Non-functional requirements

- **Dependencies:** none added (SD-40). `node:crypto` only.
- **Performance:** measured in SPI-444 (SD-41). Structural guarantees here: compile once at boot,
  lazy (SD-36), bounded scan and walk (SD-21, SD-22), no work on hop start/end lines (they carry no
  payload).
- **Memory:** compiled rules are immutable and shared; copy-on-write output.
- **Operability:** boot summary and allow lines (SD-37, SD-18); rate-limited failure line (SD-23).
- **Compatibility:** Nest 10 and 11, Node >= 18, TS 4.9 declarations.
- **Security of the feature itself:** no material in logs or errors (SD-42); constant-time comparison
  is not needed (HMAC tokens are not used for authentication). AES-GCM with random 96-bit IVs is safe
  for at most 2^32 seals per data key; `KeyProvider` implementations rotate `current()` well before
  that (README guidance, risk R10).
- **Availability:** no new runtime dependency on a network service except the app's own
  `KeyProvider` for `encrypted` scopes, which fails closed (SD-32).

## 10. Test plan

### 10.1 Unit tests (`src/sensitive/*.spec.ts`, `src/testing/*.spec.ts`)

**A. Compatibility and invariants**
- `compat: no sensitive option keeps records, replies and messages identical` (SD-01)
- `compat: sensitive false keeps 0.9.0 log text` (SD-01)
- `redactor never mutates its input (deep-frozen payload)` (SD-02, I1)
- `activator receives the original payload while sinks get redacted copies` (SD-02)
- `flow, hop and error lines are still emitted with a policy active` (SD-03)
- `error.channel logger never prints raw OutboundHttpError url, headers or body` (SD-04)
- `error.channel logger with sensitive false keeps only name, message, code, status, url` (SD-04)
- `restOut error message carries no query string or userinfo` (SD-05)
- `in-progress errors keep the key out of message and sinks` (SD-43)

**B. Marking**
- `@Sensitive marks fields on instances and subclasses` (SD-06)
- `sensitiveFieldsOf turns decorator metadata into selectors` (SD-07)
- `selector grammar: dots, [*], **, quoted keys, case` (SD-08)
- `invalid selector fails boot with level and selector` (SD-08)
- `header denylist masks values case-insensitively` (SD-09)
- `idempotency key header is hashed, or masked without a salt` (SD-09)
- `trace fields are never redacted` (SD-10, I7)
- `field rule on a protected trace field fails boot` (SD-10)

**C. Patterns and packs**
- `patterns redact nested strings, messages, stacks and causes` (SD-11)
- `pack resolution: pinned, latest, unknown` (SD-12)
- `secrets pack positive and negative corpus` (SD-12)
- `pii pack positive and negative corpus` (SD-12)
- `built-in pack rules use RE2-compatible syntax only` (SD-13)
- `pii false-positive corpus: timestamps, ids, offsets` (SD-24)
- `adjacent phone numbers are both redacted` (SD-24)
- `pii phone rule hashes by default` (SD-25)
- `mask tokens name the rule; invalid names fail boot` (SD-26)

**D. Modes and hashing**
- `masking modes: one case per mode` (SD-14)
- `partial never reveals more than half and masks short values` (SD-14)
- `hash requires a salt provider and a 32-byte salt` (SD-15, I6)
- `hash token is a keyed HMAC with the salt id` (SD-15)
- `built-in hash-or-mask rules mask without a salt` (SD-15)
- `failed salt refresh keeps the current salt and warns` (SD-16)

**E. Merge and safety**
- `merge: unions, stricter mode wins, inner levels cannot weaken, ties keep the outer mode` (SD-17, I5)
- `allow exceptions need a reason, are logged at boot and win over patterns` (SD-18)
- `regex safety rejects catastrophic and zero-length patterns` (SD-19)
- `regex engine port compiles every rule and reports rejects at boot` (SD-20)
- `long strings are cut after scanning, dropping the token that reaches the cut` (SD-21)
- `walker limits: depth, nodes, cycles, getters, toJSON, binary, Map and Set` (SD-22)
- `redaction failure writes a placeholder, never the raw value` (SD-23, I2)
- `redactor is not called when no sink writes` (SD-36)
- `boot reports all configuration errors at once` (SD-37, I8)
- `boot summary line has no data` (SD-37)
- `inbound policy missed by discovery is validated at first plan build` (SD-44)
- `config errors and boot lines never print salt or key material` (SD-42)

**F. Sinks**
- `wireTap redact delivers a redacted copy` (SD-28)
- `SensitiveRuntime is injectable and scoped to its module` (SD-39)

**G. Durable records (one test per row of section 8.2)**
- `storeMode default: plain without policy, status-only with one, defaulted scopes listed at boot` (SD-29)
- `status-only plus replay on request/reply fails boot` (SD-30)
- `matrix plain|redacted|encrypted|status-only x success, envelope, replay, store, keep, activator` (SD-30; 24 parameterized cases)
- `sealed records: round trip, tamper, key swap` (SD-31, I3)
- `key provider down at claim fails closed before dispatch` (SD-32)
- `key provider down at replay never re-runs` (SD-32, I4)
- `retired key gives replay unavailable` (SD-32)
- `saga ledger: encrypted round trip, key fetched outside the transaction` (SD-33, I9)
- `saga ledger: status-only replay` (SD-33)
- `activator duplicate on a status-only record warns and does not reply` (SD-34)
- `sealed and status-only records survive a JSON store` (SD-35)

**H. Testing helpers**
- `expectNoLeak finds every encoded form` (SD-38)
- `expectNoLeak never prints the secret` (SD-38)

**I. Flow DSL and channel integration (section 18; `src/flow/*.spec.ts`, `src/sensitive/policy-resolver.spec.ts`, `src/graph/channel-graph.spec.ts`)**
- `flow sinks use the failing step subject: union of module, source, destination, flow and step` (SD-45)
- `flow-level sensitive applies to flow sinks only` (SD-46)
- `mask-payload or storeMode at flow level fails boot` (SD-46, SD-58)
- `step and target sensitive options are scoped to their own sinks` (SD-47)
- `profiles: extends, list union, cycle, depth and unknown names` (SD-48)
- `an unreferenced profile changes nothing` (SD-48)
- `sensitive false below the module or with lower references fails boot` (SD-49)
- `mask-payload masks only the step's own rules and only the delivered copy` (SD-50)
- `mask-payload level and reason are validated at boot` (SD-50)
- `mask-payload keeps untouched references and fails instead of truncating` (SD-51)
- `wireTap redacts by default under an explicit policy; redact false needs a reason` (SD-52, SD-28)
- `jump replies are redacted in sink copies and delivered intact` (SD-53)
- `flow DSL sensitive references never change delivered messages` (SD-54, I1)
- `boot resolver reports every sensitive finding once with subject and path` (SD-55, SD-37)
- `route resolves target plans once per channel` (SD-55)
- `call-level sensitive names are validated before the request is sent` (SD-56)
- `profiles-only module options do not opt durable scopes or taps in` (SD-57, SD-29)
- `storeMode on flow or step levels fails boot; inherited storeMode is ignored there` (SD-58)
- `graph shows sensitive profile names only, never rules or reasons` (SD-59)
- `boot summary lists flow and step subjects without rules` (SD-60)
- `runtime stats count redactions by rule, sink and subject without values` (SD-61)
- `saga policy names resolve only with a runtime` (SD-63)
- `inbound defaults, activator and binding references resolve by name` (SD-64)
- `compat: flow DSL without options keeps 0.9.0 describe output, tap copies and envelopes` (SD-65)
- `inbound discovery warn line is redacted` (SD-66)
- `shared flow parameter scaffolding ships with SPI-433 and keeps 0.9.0 behaviour` (SD-67)

### 10.2 End-to-end and build tests

- `test/sensitive-leak.e2e.spec.ts: no secret reaches any sink at debug level` (SD-27): one Nest app
  on loopback with an inbound REST request/reply endpoint (each storeMode), a fire-and-forget endpoint,
  activators, a flow with a redacted wire tap, an outbound REST binding against a local server that
  echoes the key in its error body, a saga with a memory ledger, logging `hops: true` at `debug`; drives
  success, failure, duplicate and replay; `expectNoLeak` over the capture with a JWT, an API key, a
  phone, an email, a card number and an idempotency key. The leak e2e uses only the in-memory store
  and ledger; Redis/Postgres stores are covered by SPI-429's contract suite, which reuses
  `sealed and status-only records survive a JSON store` (SD-35).
- **(amended)** The leak e2e also builds the section 18.3 flow (profiles at L1, a channel profile,
  `FlowOptions.sensitive`, step and target references, a default-redacted tap, a jump whose reply
  holds a card number, a `mask-payload` transform) and asserts with `expectNoLeak` that no sink holds
  the secrets, while a destination spy asserts the delivered values of SD-54 (SD-45 to SD-54).
- `test/dist-identity.spec.ts: @Sensitive metadata crosses ESM and CJS copies` (SD-06), a new case
  in the existing file, skipped until built.
- depcruise `sensitive-no-npm` and `test/dist-typescript4.spec.ts` (SD-40).
- SPI-444: `bench/sensitive.bench.ts` (SD-41).

## 11. Documentation to update (same PR)

- **README:** new section "Sensitive data" after "Tracing & idempotency": principle (logging stays
  on, copies only), marking (decorator, selectors, denylist), packs and modes, storeMode with the
  matrix of 8.2, providers wiring, regex safety and `regexEngine`, threat-model guidance of 1.3.
  "Caveats" gains: status-only and activator replies, redacted replay, key retention must exceed the
  longest record TTL, data-key rotation before 2^32 seals, one salt per environment, the
  encoded-content limit, the E.164 false negatives, the opt-in migration recipe of section 2.
- **AGENTS.md:** "Layer boundaries" gains `sensitive-no-npm`; "Adding features" gains "new pack ->
  `packs.ts` + corpus tests + version bump" and the new ports (`SaltProvider`, `KeyProvider`,
  `RegexEngine`); "Testing rules" lists `captureSinks` and `expectNoLeak`; a new non-negotiable
  invariant: "sinks write redacted copies; never mutate the delivered message".
- **skills/:** `estela-setup` (providers, module options), `estela-flows` (`wireTap` redact,
  per-channel policies), `estela-testing` (`captureSinks`, `expectNoLeak`, the corpus),
  `estela-review` checklist (no payload in app logs without `redactForLog`; exception filters use
  `redactError`; `storeMode` chosen for every replayable endpoint; idempotency keys built from opaque
  ids, not personal data).
- **CHANGELOG:** from the release tooling.

## 12. Dependencies on other tickets

```
SPI-433 (this) ──► nothing blocks it; ships first
   │
   ├──► SPI-429 stores: persist sealed / status-only records opaquely (contract unchanged, SD-35).
   │    SPI-433 does NOT use a store-level codec (D13); MR-20 is retired in the MR spec
   │    (its D17), so no recordCodec edge exists (Q9 resolved)
   ├──► SPI-430 OutboundGrpcGateway, SPI-436 SDK outbound: their errors go through redactError;
   │    bindings accept `sensitive` like OutboundRestOptions
   ├──► SPI-431 gRPC command inbound: command endpoints are the endpoint level of 6.6
   ├──► SPI-437 OTel bridge: span attributes through SensitiveRuntime
   ├──► SPI-439 @InboundMcp: endpoint level, same storeMode rules
   ├──► SPI-444: benchmark sets budgets (SD-41); revisits maxScanBytes default
   ├──► SPI-445 (RS-): classifies SensitiveKeyUnavailableError
   │    (retryable) and SensitiveReplayUnavailableError / SensitiveRecordError (terminal), owns
   │    the retry budget
   ├──► Shared ESTELA flow parameter model (with SPI-429, SPI-445, KA-): levels, profile
   │    references, `FlowParameterResolver`, step ids and `DUPLICATE_STEP_ID`
   │    (`FlowDefinitionError`) are defined there; this spec owns the sensitive rows (section 18).
   │    (amended) SPI-433 ships first, so it ships the shared scaffolding and the resolver
   │    skeleton (SD-67); SPI-429 and SPI-445 add their members (MR OQ-14 resolved for the resolver).
   │    SPI-445 owns resilience events (SD-62); SPI-429 owns step claims (SD-58)
   └──► Koletz adoption spec (KA-): its pack, header additions, per-channel table, salt and key
        providers, and the D-PHONE choice per channel; it references profiles by name only
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

SPI-432 (graph control) is independent: the graph never carries payloads (S13). SPI-434, SPI-435,
SPI-438, SPI-440 to SPI-443 do not depend on this ticket; when they add sinks (a broker message log, a
webhook body log) they route them through `SensitiveRuntime` and extend the leak e2e.

## 13. Risks

- **R1. Unknown secret formats.** Patterns only catch known shapes; field marking is the primary
  control and packs are a safety net.
- **R2. False positives.** Over-masking can hide useful values (for example a numeric id that passes
  the card rule). Accepted: the token names the rule, `skipKeys` and `allow` fix it per scope.
- **R3. Encoded content.** A secret inside a base64 or compressed blob is not redacted at run time.
  `expectNoLeak` detects it in tests; binary values are never written (SD-22).
- **R4. Conservative regex analysis.** Some safe patterns are rejected; remedy: rewrite or a linear
  engine.
- **R5. Status-only changes duplicate behaviour.** Duplicates lose their body; request/reply replay
  is refused at boot, activator replies become silence plus a warning, and callers may hit a reply
  timeout. Documented in Caveats.
- **R6. Key retirement.** Retiring a data key before the records it sealed expire makes those
  repeats fail (`REPLAY_UNAVAILABLE`). Key retention must exceed the longest TTL.
- **R7. Salt compromise.** Tokens of low-entropy values become reversible (1.4).
- **R8. Cost of the baseline.** Every consumer gets pattern scanning on error lines; error paths only,
  measured in SPI-444.
- **R9. Policy drift between services.** Each service compiles its own policy; a value redacted in
  one may be logged by another. An adopter applies the same policy across its services (the Koletz
  adoption spec does so for Koletz).
- **R10. AES-GCM IV space.** Random 96-bit IVs are safe for at most 2^32 seals per data key; a
  `KeyProvider` that never rotates exceeds it in very high-volume scopes. Documented; rotation is the
  provider's job.
- **R11. Opt-in changes duplicate behaviour.** Turning on any policy defaults durable scopes to
  `status-only` (D5). Mitigated by boot failure for replay endpoints and the boot list of defaulted
  scopes (SD-29, SD-30).
- **R12. Key-name over-masking.** `secrets.keys` masks every key named `token`, including harmless
  ones (pagination tokens). Accepted; `allow` with reason restores them per scope.
- **R13. Tap copies share subtrees.** A redacted tap copy shares unchanged subtrees with the live
  message (copy-on-write), as the 0.9.0 tap shares the whole payload; a subscriber that mutates its
  copy mutates the main path. Not an isolation boundary; README Caveats.
- **R14. `mask-payload` with `hash`.** Hash tokens delivered downstream change on every salt rotation,
  so a remote service that stores them loses correlation. README guidance: prefer `mask` or `remove`
  for delivered data.
- **R15. Profile edits reach many subjects.** One profile change alters the redaction of every subject
  that references it; the boot summary (SD-60) and the graph names (SD-59) show the reach.

## 14. Decisions log

| # | Question | Decision | Reason |
|---|---|---|---|
| D1 | Redact the real message or copies | Copies for sinks only | Activators and remote services need real values; logging stays on |
| D2 | Fix the S3 and S11 leaks behind an option | No, unconditional `fix` | They are bugs; the 0.9.0 code already promises the url never reaches `message` |
| D3 | Baseline without configuration | pinned `secrets@1` pack + header denylist (idempotency key masked) on log sinks; stores untouched; `sensitive: false` opts out | Safe default that changes no API or record |
| D4 | Bare selector meaning | Root key only | Explicit `**.` avoids surprise matches |
| D5 | Default `storeMode` under a policy | `status-only` | Never stores a secret by default; replay endpoints fail at boot and must choose |
| D6 | `redacted` replay as a default | Never; explicit only | Replaying `[REDACTED]` as data silently corrupts callers |
| D7 | Sagas inheriting the module policy | Only through `SagaRunnerOptions.sensitive` | The runner is built by the app, outside the module; no hidden coupling |
| D8 | `hash` without salt | Boot error | Unsalted hashes of phones are reversible |
| D9 | Bypass of the regex analysis | None with the native engine; use a linear engine | A bypass would reintroduce ReDoS through config |
| D10 | Mask token content | `[REDACTED:<rule>]` | Debuggable false positives without data |
| D11 | Mode conflict on one path | Stricter wins | Lower levels can only add |
| D12 | Encryption | AES-256-GCM, AAD bound to `scope::key`, key id in the envelope | Integrity and anti-swap; rotation by id |
| D13 | Where store modes are applied | Above the store (inbound gate, activator wrapper, saga runner), not through a store-level codec (MR-20, retired by the MR spec's D17) | Needs async key fetch before the claim, `scope`/`key` for the AAD, and must work with stores that predate SPI-429 |
| D14 | Hash without a salt for built-in rules | Hash-or-mask: built-in rules mask when no salt exists; only an explicit user `hash` fails boot | Mask is never weaker than hash; the baseline and `pii` stay usable without a salt |
| D15 | Context checks in patterns | `accept` hook in code, not consumed context characters | Consumed context makes adjacent values miss (`+502... +502...`); RE2 has no lookaround |
| D16 | Free `redactForLog` functions | Injectable `SensitiveRuntime` only | No process-global state; two apps in one process (tests) keep their own policies |
| D17 | The S12 message leak | Unconditional `fix`: key removed from `IdempotencyInProgressError.message` | Same reasoning as D2; the inbound twin already omits it |
| D18 | Which channel is L2 for a send step's sensitive policy | Source **and** destination (union) | The model names the destination; for a union concern adding the source never weakens and keeps data declared sensitive on arrival protected when a send fails |
| D19 | Rules used by `mask-payload` | Only the step's own reference (its `use` profiles and inline rules) | A module or channel edit must never change what remote services receive |
| D20 | Wire-tap default under a policy | Redacted by default only when an explicit policy (SD-57) reaches the tap; 0.9.0 shared copy otherwise. The tap's levels also include the flow's source channel (a union superset of the model's rule 4.4) | The model says the tap copy is always redacted; the compat contract (section 2) requires 0.9.0 behaviour with no new configuration |
| D21 | Profiles-only module options | Not an explicit policy (SD-57) | Declaring a library of profiles must not flip every durable scope to `status-only` |
| D-PHONE | Masking of phone numbers | Customer numbers: `hash` (HMAC, salted) by default; the platform's own business/sender numbers may use `partial` through an app rule | `partial` is identifying (1.4); owner default, may be overridden (Q2) |
| D-REDIS-DOWN | Shared state unavailable | Here: `KeyProvider` unavailable fails closed with a retryable error, never fail-open, for every encrypted scope (stricter than the owner default for scopes without side effects: a fail-open encrypted scope would have to store plaintext or skip the claim, and skipping the claim is already SPI-429's fail-open); `SaltProvider` refresh failure keeps the last salt, never unsalted. The idempotency store itself is SPI-429's (side-effecting channels fail closed, others configurable, default fail-closed); `storeMode` adds no fallback | Owner default, may be overridden (Q6) |

## 15. Open questions

| # | Question | Default taken | Owner |
|---|---|---|---|
| Q1 | Keep the baseline on by default (D3), or require an explicit `sensitive` option? | On | ESTELA maintainer |
| Q2 | Confirm D-PHONE (hash customer numbers, partial only for business numbers) | As D-PHONE | Platform owner |
| Q3 | Allow a per-pattern bypass of the regex analysis with a logged reason? | No (D9) | ESTELA maintainer |
| Q4 | Activator duplicate on a status-only record: silence + warn (today's no-cache path) or a typed error to the reply channel? | Silence + warn | ESTELA maintainer |
| Q5 | Transform idempotency keys at rest (HMAC) in a follow-up ticket? | Not in SPI-433; guidance only | ESTELA maintainer |
| Q6 | Confirm D-REDIS-DOWN as applied to providers (no fail-open for `encrypted`) | As D-REDIS-DOWN | Platform owner |
| Q7 | `hashChars` default 16 (64 bits) | 16 | ESTELA maintainer |
| Q8 | `maxScanBytes` default 64 KiB until SPI-444 measures | 64 KiB | ESTELA maintainer (SPI-444) |
| Q9 | Align the MR spec: drop or reword MR-20 (store-level codec) now that SPI-433 encodes above the store (D13) | Resolved 2026-11-09: MR-20 retired (MR spec D17) | ESTELA maintainer (SPI-429 author) |
| Q10 | Open the resilience ticket under SPI-428 and give its key, so section 12 and the error classification can name it | Resolved 2026-11-09: `SPI-445` (RS OQ-1) | Platform owner |
| Q11 | Confirm the `secrets.keys` key list (R12) | As in 6.4 | ESTELA maintainer |
| Q12 | Path of the shared ESTELA flow parameter model in `docs/` (section 18 links it by name until it lands; the same question as RS OQ-16 and MR OQ-14) | Not yet in the repo | ESTELA maintainer |
| Q13 | `sensitive: false` at L1 with lower references: boot error (`SENSITIVE_DISABLED_WITH_REFS`, SD-49) or lower references silently ignored? The model does not say | Boot error | ESTELA maintainer |
| Q14 | Error class when one boot has findings of several concerns (resilience and sensitive): the model says "the class of its concern" | (amended) The rule of RS-67, shared by the three specs: one concern, its own class; several concerns, `FlowDefinitionError`; `findings` lists all as `FlowParameterFinding` | ESTELA maintainer (with SPI-445) |
| Q15 | `mask-payload` on `route` targets: the model lists neither permission nor refusal | Refused (`MASK_PAYLOAD_LEVEL`) | ESTELA maintainer |
| Q16 | If SPI-429 caches step results under `StepIdempotencyOptions`, step scopes become durable and need `storeMode` (SD-58) | Not cached; no `storeMode` on steps | ESTELA maintainer (SPI-429 author) |
| Q17 | Default step `id` (`<kind>#<index>`) in `describe()`: emitting it always breaks the 0.9.0 graph deep-equal (`insurance.spec.ts:61`); this spec emits `sensitive` only when set (SD-59, SD-65) | (amended) The rule of RS-66, shared by the three specs: emit `id` only when it is explicit or when the step carries an annotation of any concern (`sensitive`, a resilience `policy`, an `idempotency` claim) | ESTELA maintainer (with SPI-432) |
| Q18 | Show `apply: 'mask-payload'` in the graph? The model's 5.1 has no key for it | Not shown; boot warn line only (SD-60) | ESTELA maintainer |

## 16. Definition of done

- All MUST requirements implemented; SD-20 and SD-39 implemented or explicitly deferred in the PR.
- Every test named in section 10 exists and passes; `npm run verify` green; `npm run comments:en`
  green on touched files; CI jobs green.
- Leak e2e passes at debug level with all four storeModes.
- README, AGENTS.md and skills updated (section 11) in the same PR.
- No runtime dependency added; `sensitive-no-npm` rule in place.
- PR description per template, with `BREAKING CHANGE` absent (additive) and the three `fix` items listed.
- **(amended)** Section 18 implemented: every SD-45..SD-67 test of group I passes; the shared flow
  parameter model linked by path (Q12).
- Open questions Q1 to Q18 answered or carried to tickets; Q9 is already resolved (MR-20 retired,
  MR spec D17).
- The CHANGELOG lists the three `fix` items (S3, S11, S12) and the opt-in migration note.

## 17. Traceability

| Requirement | Test(s) | Ticket |
|---|---|---|
| SD-01 | `compat: no sensitive option keeps records, replies and messages identical`; `compat: sensitive false keeps 0.9.0 log text` | SPI-433 |
| SD-02 | `redactor never mutates its input (deep-frozen payload)`; `activator receives the original payload while sinks get redacted copies` | SPI-433 |
| SD-03 | `flow, hop and error lines are still emitted with a policy active` | SPI-433 |
| SD-04 | `error.channel logger never prints raw OutboundHttpError url, headers or body`; `error.channel logger with sensitive false keeps only name, message, code, status, url` | SPI-433 |
| SD-05 | `restOut error message carries no query string or userinfo` | SPI-433 |
| SD-06 | `@Sensitive marks fields on instances and subclasses`; `test/dist-identity.spec.ts: @Sensitive metadata crosses ESM and CJS copies` | SPI-433 |
| SD-07 | `sensitiveFieldsOf turns decorator metadata into selectors` | SPI-433 |
| SD-08 | `selector grammar: dots, [*], **, quoted keys, case`; `invalid selector fails boot with level and selector` | SPI-433 |
| SD-09 | `header denylist masks values case-insensitively`; `idempotency key header is hashed, or masked without a salt` | SPI-433 |
| SD-10 | `trace fields are never redacted`; `field rule on a protected trace field fails boot` | SPI-433 |
| SD-11 | `patterns redact nested strings, messages, stacks and causes` | SPI-433 |
| SD-12 | `pack resolution: pinned, latest, unknown`; `secrets pack positive and negative corpus`; `pii pack positive and negative corpus` | SPI-433 |
| SD-13 | `built-in pack rules use RE2-compatible syntax only` | SPI-433 |
| SD-14 | `masking modes: one case per mode`; `partial never reveals more than half and masks short values` | SPI-433 |
| SD-15 | `hash requires a salt provider and a 32-byte salt`; `hash token is a keyed HMAC with the salt id`; `built-in hash-or-mask rules mask without a salt` | SPI-433 |
| SD-16 | `failed salt refresh keeps the current salt and warns` | SPI-433 |
| SD-17 | `merge: unions, stricter mode wins, inner levels cannot weaken, ties keep the outer mode` | SPI-433 |
| SD-18 | `allow exceptions need a reason, are logged at boot and win over patterns` | SPI-433 |
| SD-19 | `regex safety rejects catastrophic and zero-length patterns` | SPI-433 |
| SD-20 | `regex engine port compiles every rule and reports rejects at boot` | SPI-433 |
| SD-21 | `long strings are cut after scanning, dropping the token that reaches the cut` | SPI-433 (default revisited in SPI-444) |
| SD-22 | `walker limits: depth, nodes, cycles, getters, toJSON, binary, Map and Set` | SPI-433 |
| SD-23 | `redaction failure writes a placeholder, never the raw value` | SPI-433 |
| SD-24 | `pii false-positive corpus: timestamps, ids, offsets`; `adjacent phone numbers are both redacted` | SPI-433 |
| SD-25 | `pii phone rule hashes by default` | SPI-433 |
| SD-26 | `mask tokens name the rule; invalid names fail boot` | SPI-433 |
| SD-27 | `test/sensitive-leak.e2e.spec.ts: no secret reaches any sink at debug level` | SPI-433 |
| SD-28 | `wireTap redact delivers a redacted copy` | SPI-433 |
| SD-29 | `storeMode default: plain without policy, status-only with one, defaulted scopes listed at boot` | SPI-433 |
| SD-30 | `status-only plus replay on request/reply fails boot`; matrix cases (group G) | SPI-433 |
| SD-31 | `sealed records: round trip, tamper, key swap` | SPI-433 |
| SD-32 | `key provider down at claim fails closed before dispatch`; `key provider down at replay never re-runs`; `retired key gives replay unavailable` | SPI-433 (retry layer: SPI-445, RS-17a) |
| SD-33 | `saga ledger: encrypted round trip, key fetched outside the transaction`; `saga ledger: status-only replay` | SPI-433 |
| SD-34 | `activator duplicate on a status-only record warns and does not reply` | SPI-433 |
| SD-35 | `sealed and status-only records survive a JSON store` | SPI-433 (reused by SPI-429 store tests) |
| SD-36 | `redactor is not called when no sink writes` | SPI-433 |
| SD-37 | `boot reports all configuration errors at once`; `boot summary line has no data` | SPI-433 |
| SD-38 | `expectNoLeak finds every encoded form`; `expectNoLeak never prints the secret` | SPI-433 |
| SD-39 | `SensitiveRuntime is injectable and scoped to its module` | SPI-433 |
| SD-40 | depcruise `sensitive-no-npm`; `test/dist-typescript4.spec.ts` | SPI-433 |
| SD-41 | `bench/sensitive.bench.ts` | SPI-444 |
| SD-42 | `config errors and boot lines never print salt or key material` | SPI-433 |
| SD-43 | `in-progress errors keep the key out of message and sinks` | SPI-433 |
| SD-44 | `inbound policy missed by discovery is validated at first plan build` | SPI-433 |
| SD-02 (amended) | as above, plus `flow DSL sensitive references never change delivered messages` | SPI-433 |
| SD-17 (amended) | as above, plus `flow sinks use the failing step subject: union of module, source, destination, flow and step` | SPI-433 |
| SD-27 (amended) | as above (the leak e2e covers the section 18.3 flow, 10.2) | SPI-433 |
| SD-28 (amended) | as above, plus `wireTap redacts by default under an explicit policy; redact false needs a reason` | SPI-433 |
| SD-29 (amended) | as above, plus `profiles-only module options do not opt durable scopes or taps in` | SPI-433 |
| SD-37 (amended) | as above, plus `boot resolver reports every sensitive finding once with subject and path` | SPI-433 |
| SD-45 | `flow sinks use the failing step subject: union of module, source, destination, flow and step` | SPI-433 |
| SD-46 | `flow-level sensitive applies to flow sinks only`; `mask-payload or storeMode at flow level fails boot` | SPI-433 |
| SD-47 | `step and target sensitive options are scoped to their own sinks` | SPI-433 |
| SD-48 | `profiles: extends, list union, cycle, depth and unknown names`; `an unreferenced profile changes nothing` | SPI-433 |
| SD-49 | `sensitive false below the module or with lower references fails boot` | SPI-433 |
| SD-50 | `mask-payload masks only the step's own rules and only the delivered copy`; `mask-payload level and reason are validated at boot` | SPI-433 |
| SD-51 | `mask-payload keeps untouched references and fails instead of truncating` | SPI-433 |
| SD-52 | `wireTap redacts by default under an explicit policy; redact false needs a reason` | SPI-433 |
| SD-53 | `jump replies are redacted in sink copies and delivered intact` | SPI-433 |
| SD-54 | `flow DSL sensitive references never change delivered messages` | SPI-433 |
| SD-55 | `boot resolver reports every sensitive finding once with subject and path`; `route resolves target plans once per channel` | SPI-433 (resolver shared with SPI-429, SPI-445) |
| SD-56 | `call-level sensitive names are validated before the request is sent` | SPI-433 (SDK and gRPC calls: SPI-436, SPI-430) |
| SD-57 | `profiles-only module options do not opt durable scopes or taps in` | SPI-433 |
| SD-58 | `storeMode on flow or step levels fails boot; inherited storeMode is ignored there` | SPI-433 (step claims: SPI-429) |
| SD-59 | `graph shows sensitive profile names only, never rules or reasons` | SPI-433 (graph: SPI-432) |
| SD-60 | `boot summary lists flow and step subjects without rules` | SPI-433 |
| SD-61 | `runtime stats count redactions by rule, sink and subject without values` | SPI-433 |
| SD-62 | `resilience events are redacted with the step policy` | SPI-445 |
| SD-63 | `saga policy names resolve only with a runtime` | SPI-433 |
| SD-64 | `inbound defaults, activator and binding references resolve by name` | SPI-433 (gRPC out sinks: SPI-430) |
| SD-65 | `compat: flow DSL without options keeps 0.9.0 describe output, tap copies and envelopes` | SPI-433 |
| SD-66 | `inbound discovery warn line is redacted` | SPI-433 |
| SD-67 | `shared flow parameter scaffolding ships with SPI-433 and keeps 0.9.0 behaviour` | SPI-433 (first in the agreed delivery order; SPI-429 and SPI-445 add their members) |

## 18. Flow DSL and channel integration

Added 2026-11-09 for the epic goal "ESTELA must embrace these characteristics and receive the
parameters that let flows incorporate them". This section applies the **ESTELA flow parameter
model** (shared by SPI-433, SPI-429, SPI-445 and the KA adoption spec; the shared document is the
source of truth for levels, profile references and option shapes, and its path is fixed when it
lands in `docs/`, Q12) to the sensitive-data concern. It restates only what this spec must test;
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

### 18.2 Levels for the sensitive concern

The model's levels (L0 built-in, L1 module, L2 channel, L3 flow, L4 step/endpoint, L5 call) map onto
SD-17 as follows. Merge is SD-17 unchanged: union of `fields`, `headers`, `patterns` and `packs`;
per path the stricter mode wins; `allow` is the only way to weaken and applies to its own level and
the levels inside it; `storeMode` comes from the most specific level that sets it.

| Subject | Levels merged, outer to inner |
|---|---|
| `flow:<flow>` (flow claim failure record, flow error envelope) | L0 baseline, L1 module, L2 source channel, L3 `FlowOptions.sensitive`, then the remaining levels of the failing step's subject: its L4 step and target levels and, for a send step, the destination L2 (SD-45) |
| `flow:<flow>#<stepId>`, non-send step (`filter`, `transform`, `handle`) | L1, L2 source channel, L3, L4 step |
| `flow:<flow>#<stepId>`, send step (`to`, `publish`, `route`, `fanoutTo`, `jumpTo`, `jump`) | L1, L2 source channel **and** L2 destination channel, L3, L4 step, L4 target |
| wire-tap copy | L1, L2 tap channel, L2 source channel, L3, L4 step (SD-52) |
| activator `activator:<Class>.<method>` | L1, L2 own channel, L4 `ActivatorOptions.sensitive` |
| inbound `inbound:<channel>` | L1 module, L1 `InboundDefaults.sensitive` (`forRoot({ inbound })`), L2 own channel, L4 `InboundSpec.sensitive` |
| outbound REST / gRPC out | L1, L2 bound channel, L4 binding (`OutboundRestOptions.sensitive`, `bindGrpcOut` options), L5 call |
| saga | `SagaRunnerOptions.sensitive.policy` (plus L1 when `runtime` is passed) |

The model names the destination channel as L2 of a send step. Because the sensitive merge is a
union, this spec also unions the **source** channel for send steps (D18): the data that arrived on a
channel declared sensitive stays sensitive when a send to an unconfigured channel fails. A union
never weakens, so this is a superset of the model's rule, not a change to it. For the same reason the wire-tap copy also unions the flow's source channel, which the model's rule 4.4 (module, tap channel, flow, step) leaves out (D20).

An inbound endpoint's own channel is its L2 here, as in the model's 1.1. The other two concerns do not
read it: resilience refuses channel defaults on inbound endpoints (RS-56, RS-37) and idempotency keeps
the 0.9.0 inbound chain (MR D19, MR OQ-16). Sensitive keeps it because a union only adds rules, so the
difference cannot weaken another concern's behaviour.

Runtime caps are not levels and do not exist for this concern. Floors that no lower level lifts:
the baseline stays on unless L1 sets `false`; `storeMode: 'plain'` needs `storeModeReason`;
`mask-payload` needs `applyReason`; `redact: false` needs `redactReason`.

### 18.3 Parameters a flow author writes

```ts
IntegrationModule.forRoot({
  sensitive: {
    packs: ['secrets@1'],
    salt: envSaltProvider('ESTELA_SALT', 'ESTELA_SALT_ID'),
    profiles: {
      pii: { packs: ['pii@1'] },
      card: { fields: [{ path: '**.pan', mode: 'partial', keepLast: 4 }] },
      'card-pii': { extends: ['card', 'pii'] },
    },
  },
  channels: [{ name: 'payments.charge', type: 'direct', sensitive: 'card' }],
}, [{                                       // flows: second argument of forRoot (integration.module.ts:132-135)
    name: 'loan',
    build: () =>
      IntegrationFlow.from('loan.requests', { sensitive: 'pii' })                 // L3
        .handle(enrich, { id: 'enrich', sensitive: { fields: ['ssn'] } })         // L4
        .wireTap('loan.audit', { id: 'audit' })                                   // redacted by default (SD-52)
        .jumpTo([{ channel: 'credit.check', sensitive: 'card' }], { id: 'credit' }) // per target
        .transform(toPartnerShape, { id: 'partner', sensitive: {
            fields: ['ssn'], apply: 'mask-payload', applyReason: 'partner must not receive SSN' } })
        .to('partner.out', { id: 'send' }),
}]);
```

| DSL method | `sensitive` | `apply: 'mask-payload'` | Sinks the step's subject governs |
|---|---|---|---|
| `filter(predicate, opts?)` | yes | no (`MASK_PAYLOAD_LEVEL`) | flow error envelope on a predicate throw |
| `transform(fn, opts?)` | yes | yes, on its output | error envelope |
| `handle(fn, opts?)` | yes | yes, on its output | error envelope; step claim failure record (SPI-429); resilience events (SPI-445) |
| `wireTap(channel, opts?)` | yes | no (`MASK_PAYLOAD_LEVEL`) | the tap copy (SD-52) |
| `fanoutTo(dests, opts?)`, `FlowTarget.sensitive` | yes, per step and per target | yes, on each hop copy | error envelope; `wait: false` envelopes (`forget.ts`) |
| `jumpTo(dests, opts?)`, `jump(channel, { sensitive?, id? })` | yes, per step and per target | yes, on each hop copy | error envelope; `wait: false` envelopes; `jumpReplies[<ch>]` in later sinks (SD-53) |
| `publish(channel, routingKey?, opts?)` / `publish(channel, opts)` | yes | yes, on the hop copy | error envelope |
| `route(fn, opts?)` | yes, resolved per target channel | no (`MASK_PAYLOAD_LEVEL`, Q15) | error envelope |
| `to(channel, opts?)` | yes | yes, on the hop copy | error envelope |
| `reply(options?)` | no field | no | none: the reply is the caller's data (model 4.4) |

### 18.4 Requirements

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| SD-45 | MUST | Every sink a flow writes is redacted with the policy of a named subject resolved per 18.2. A step's sink copies use `flow:<flow>#<stepId>`; the flow error envelope (`flow-executor.ts:139-150`) and the flow claim failure record (`:80`) use `flow:<flow>` united with every level of the failing step's subject (its L4 step and target levels and, for a send step, the destination channel); the executor records which step failed before it rethrows. The flow error envelope carries the error and ids only, never the payload (`flow-executor.ts:141`), so these sinks redact the error's message, stack and own enumerable properties (SD-04, SD-11). Send steps unite the source and the destination channel (D18). | G module `fields: ['**.token']`, source channel `loan.requests` with `fields: ['**.card']`, destination channel `audit.out` with `fields: ['**.iban']`, flow `sensitive: { packs: ['pii@1'] }`, an idempotency store, and a `publish('audit.out', { sensitive: { fields: ['**.ssn'] } })` whose send throws an error with own enumerable properties `token`, `card`, `iban`, `ssn` and an E.164 phone in its `message`; W a message with an `idempotencyKey` runs; T the S3 line and the S8 failure record hold none of the five values; in another run a `handle` step without options throws the same error and its S3 line masks `token`, `card` and the phone but writes `iban` and `ssn` as-is | `flow sinks use the failing step subject: union of module, source, destination, flow and step` |
| SD-46 | MUST | `IntegrationFlow.from(source, options?: FlowOptions)` accepts `sensitive?: SensitiveRef` (L3). It applies to every sink of that flow (18.2) and never to a delivered value. `apply: 'mask-payload'` at L3 fails boot (`MASK_PAYLOAD_LEVEL`); `storeMode` at L3 fails boot (`STORE_MODE_LEVEL`, SD-58). | G `from('a', { sensitive: 'pii' })` (profile `pii` = `pii@1`) and a `handle` that throws an error whose message holds the email it received; W a message with an email runs; T the S3 line hashes or masks the email and the handler received it intact; G `from('a', { sensitive: { apply: 'mask-payload', applyReason: 'x' } })`; T boot fails naming flow and option path | `flow-level sensitive applies to flow sinks only`; `mask-payload or storeMode at flow level fails boot` |
| SD-47 | MUST | Every DSL step except `reply` accepts `StepCommonOptions` (`id?`, `sensitive?`), and each `FlowTarget` of `fanoutTo`/`jumpTo` accepts `sensitive?` (table 18.3). A target's policy applies only to that target's hop sinks and `wait: false` envelope; siblings resolve independently. | G `fanoutTo([{ channel: 'a', wait: false, sensitive: { patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }] } }, { channel: 'b', wait: false }])` where both sends reject with an error whose message holds `XSECRET1234` (the `wait: false` envelope carries only `serializeError`, `forget.ts:17`, so a field rule could not reach it); W the step runs; T the envelope for `a` holds `[REDACTED:test.x]`, the envelope for `b` holds `XSECRET1234` (no rule reaches `b`) | `step and target sensitive options are scoped to their own sinks` |
| SD-48 | MUST | `SensitiveModuleOptions.profiles` declares named policies (`NamedSensitivePolicy`, names `^[a-z0-9][a-z0-9._-]{0,63}$`). `extends` takes one name or a list, unioned in order; a cycle fails boot (`PROFILE_CYCLE`), a chain of more than 8 `extends` hops from any profile fails boot (`PROFILE_DEPTH`), an unknown name anywhere fails boot (`UNKNOWN_PROFILE`). L2..L5 accept a `SensitiveRef`: a name, a list of names (unioned in order), or an inline policy with `use`, unioned with the named profiles. A declared profile adds no rule anywhere until a level references it, but every declared profile is still compiled and validated at boot (an invalid selector or unsafe regex in an unreferenced profile fails boot). | G profiles `a extends b`, `b extends a`, a reference `'missing'` and a chain of 10 profiles (9 hops); W boot; T one `SensitiveConfigError` with `PROFILE_CYCLE`, `UNKNOWN_PROFILE` and `PROFILE_DEPTH` findings; a chain of 9 profiles (8 hops) boots; G a valid `card` profile referenced by nothing; T no sink output differs from the same app without it | `profiles: extends, list union, cycle, depth and unknown names`; `an unreferenced profile changes nothing` |
| SD-49 | MUST | `sensitive: false` is valid only as `forRoot({ sensitive: false })`. Anywhere else (`InboundDefaults.sensitive`, L2..L5) it is a finding `SENSITIVE_FALSE_BELOW_MODULE` (boot error, except first-call error for L5, SD-56). When `forRoot({ sensitive: false })` is set, any `InboundDefaults` or L2..L4 sensitive reference fails boot with `SENSITIVE_DISABLED_WITH_REFS` (Q13), and an L5 reference fails its first call with the same code: a channel author must not believe a disabled runtime protects them. | G `forRoot({ sensitive: false, channels: [{ name: 'a', type: 'direct', sensitive: { fields: ['x'] } }] })`; W boot; T `SensitiveConfigError` with `SENSITIVE_DISABLED_WITH_REFS` naming channel `a`; G a step `sensitive: false`; T `SENSITIVE_FALSE_BELOW_MODULE` naming the step | `sensitive false below the module or with lower references fails boot` |
| SD-50 | MUST | `sensitive: { apply: 'mask-payload', applyReason }` is accepted only on an L4 flow step or target of the kinds in 18.3; it masks the output of `transform`/`handle`, or the hop copy sent by `publish`/`to`/`fanoutTo`/`jumpTo`/`jump`, in the payload and in each `headers.jumpReplies` value; other headers are untouched. It uses only the rules of that step's own reference (its `use` profiles plus inline rules), never L1..L3 (D19). `applyReason` is 1..200 chars and is logged at boot (warn: subject and reason). Missing reason, or the option at L1..L3, on `filter`, `wireTap`, `route` or `reply`, fails boot (`MASK_PAYLOAD_LEVEL`). On a send step the main path keeps the original message. | G a module rule `fields: ['**.email']` and `publish('p', { sensitive: { fields: ['ssn'], apply: 'mask-payload', applyReason: 'partner' } })` followed by `handle(spy)`; W a message with `ssn: '123'` and an `email`; T the `p` subscriber gets `ssn: '[REDACTED:field]'`, `spy` gets `'123'`, one boot warn line names the step and reason; a module rule on `email` does not mask the delivered email | `mask-payload masks only the step's own rules and only the delivered copy`; `mask-payload level and reason are validated at boot` |
| SD-51 | MUST | A mask-payload copy is faithful or the step fails: untouched subtrees keep their reference (Buffers, Dates, class instances); a node on a changed path is rebuilt only when it is a plain object or array. When the copy cannot be faithful (walk limit of SD-22 reached, a string the step's own pattern rules must scan exceeds `maxScanBytes`, a cycle or getter on a changed path, a non-plain object on a changed path, or the redactor throws), the step fails with non-retryable `SensitiveMaskError` (`SENSITIVE_MASK_FAILED`) and nothing is sent. `[REDACTION_FAILED]`, `[TRUNCATED]` and other SD-22 placeholders are never delivered as data. | G a mask-payload `transform` with `fields: ['ssn']` and one pattern rule, whose output has a `Buffer` sibling of the masked field, and a second run whose output holds a 70 KiB string outside `ssn`; W both run; T the first delivers the same Buffer reference and the masked field; the second fails with `SENSITIVE_MASK_FAILED`, reaches error.channel, and the destination receives nothing | `mask-payload keeps untouched references and fails instead of truncating` |
| SD-52 | MUST | Wire-tap redaction (SD-28 amended). The tap copy's policy is the union of module, tap channel, source channel, flow and step. When any of these levels holds an explicit policy (SD-57; the baseline does not count), the copy is redacted by default; `redact: false` then keeps the 0.9.0 shared copy and needs `redactReason` (1..200 chars, logged at boot), else boot fails. With no explicit rule, the 0.9.0 copy is kept unless `redact: true`, which applies the baseline. The tap stays fire-and-forget (`wire-tap.step.ts:16`). | G a module policy on `**.token` and `.wireTap('audit')`; W a message with a token; T the audit subscriber sees the mask and the main path the token; with `{ redact: false }` boot fails; with `{ redact: false, redactReason: 'raw audit store' }` the subscriber sees the token and boot logged the reason; with no policy and no option the subscriber receives the same payload reference | `wireTap redacts by default under an explicit policy; redact false needs a reason` |
| SD-53 | MUST | In any sink copy that includes message headers, each `headers.jumpReplies[<ch>]` value is redacted as a payload with the writing subject's policy united with L2 of `<ch>` and that jump target's `sensitive`. A key of `jumpReplies` is a channel name and is kept. `reply({ payload: 'jumpMerge' })` and later hops deliver the original replies. | G `jumpTo([{ channel: 'credit.check', sensitive: 'card' }])` whose reply holds `pan: '4111111111111111'`, then `.wireTap('audit')` and `.reply({ payload: 'jumpMerge' })` under a module policy, with a `replyChannel` on the message; W the flow runs; T the audit copy holds `jumpReplies['credit.check'].pan` as `***1111` (6.3 `partial`), and the reply to the caller holds the full `pan` | `jump replies are redacted in sink copies and delivered intact` |
| SD-54 | MUST | Delivered-data invariant for flows (extends SD-02, I1): with any combination of L1..L4 sensitive references and no `mask-payload`, the payload and headers delivered to handlers, next steps, `to`/`publish`/`route`/`fanoutTo`/`jumpTo` destinations, outbound calls and `reply` are the same references as with no sensitive configuration. | G a deep-frozen payload, every DSL step with a `sensitive` reference (its `filter`/`transform`/`handle` functions return their input unchanged), profiles at all levels; W the flow runs to `reply`; T no `TypeError`, every destination spy receives the same payload reference, and the reply payload is the input reference | `flow DSL sensitive references never change delivered messages` |
| SD-55 (amended) | MUST | Boot resolution. `SensitiveRuntime.compile` (7.1) compiles the module policy and the profiles; the `FlowParameterResolver` then resolves `InboundDefaults.sensitive` (part of L1) and every L2..L4 `SensitiveRef` (channels, endpoints, activators, bindings, `bindGrpcOut`, flows, steps, targets) after channels are created and before activators subscribe, freezes one plan per subject, and throws one `SensitiveConfigError` whose `findings` lists every finding (`code`, `severity`, `subject`, `path`) and whose message names subject and option path, never values (SD-42). (amended) The resolver is shared with SPI-445 and SPI-429: when the same boot also has error findings of another concern, exactly one error is thrown with the class that RS-67 sets (`FlowDefinitionError`), and the sensitive findings are carried in it as `FlowParameterFinding` with `concern: 'sensitive'`. Warnings are logged once each. `route` resolves its plan per target channel at first use and caches it (at most one entry per registered channel); its profile names are still checked at boot. No per-message resolution happens for other steps. | G an unknown profile on a step, a cycle in profiles and a mask-payload on a filter, in one app; W boot; T one error with three findings, message contains `flow 'loan' step 'credit': sensitive.use unknown profile` and no rule body; no activator or flow is subscribed | `boot resolver reports every sensitive finding once with subject and path`; `route resolves target plans once per channel` |
| SD-56 | MUST | L5 references (`OutboundRestCallOptions.sensitive`, SDK and gRPC call options) are validated on the first call that carries them, against the frozen profile registry: an unknown name throws `SensitiveConfigError` (`UNKNOWN_PROFILE`) and `false` throws it with `SENSITIVE_FALSE_BELOW_MODULE`, before the request is sent. | G `gateway.request(target, msg, { sensitive: 'nope' })`; W called; T it rejects with `UNKNOWN_PROFILE` and the stub server received no request | `call-level sensitive names are validated before the request is sent` |
| SD-57 | MUST | An "explicit policy" (for the `storeMode` default of SD-29 and the tap default of SD-52) is a resolved reference that holds at least one rule (`fields`, `headers`, `patterns`, `packs`, `allow`) or a `storeMode`. A module object that declares only `profiles`, providers (`salt`, `keys`, `regexEngine`) or limits is not one. | G `forRoot({ sensitive: { profiles: { pii: { packs: ['pii@1'] } } } })`, an activator with idempotency and no `storeMode`, and a flow with `.wireTap('audit')`; W boot, a request to the activator and a message through the flow; T the activator record is plain, no defaulted-scope warn line is logged and the tap copy shares the payload reference | `profiles-only module options do not opt durable scopes or taps in` |
| SD-58 | MUST | Flow and step scopes have no `storeMode`. A `storeMode` written at L3 or on a flow step or target fails boot (`STORE_MODE_LEVEL`); one inherited from L1 or L2 is ignored for flow and step scopes (it still governs durable scopes on that channel). Step claim records added by SPI-429 (`StepIdempotencyOptions`) hold no payload, and their failure records hold the error redacted with the step's subject; if SPI-429 later caches a step result, that scope becomes durable and SD-29 applies (Q16). | G channel `a` with `sensitive: { storeMode: 'plain', storeModeReason: 'r' }`, a flow from `a`, and a step `sensitive: { storeMode: 'encrypted' }`; W boot; T one `STORE_MODE_LEVEL` finding names the step, none names the channel | `storeMode on flow or step levels fails boot; inherited storeMode is ignored there` |
| SD-59 | MUST | Graph annotations (model 5.1) carry names only: step and dest `sensitive` lists (profile names, pack names with version, `'inline'` for inline rules), `GraphFlowEntry.options.sensitive`, `GraphNode.sensitive`, `GraphInboundRef.sensitive`, `GraphOutboundRef.sensitive`. They never contain field paths, regex sources, `allow` paths or reasons, `applyReason`, `redactReason` or `storeModeReason`. A `sensitive` key appears only where a non-baseline reference reaches the node or step. Declared profile names appear in `GraphSnapshot.module.profiles` (model 5.1) only when `profiles` is set. | G a flow with an inline rule on `**.ssn` with an allow reason and a profile `pii`; W `GET /integration/graph`; T the step shows `sensitive: ['secrets@1', 'pii', 'inline']` and the JSON contains neither `ssn` nor the reason; with no sensitive configuration the snapshot deep-equals 0.9.0's | `graph shows sensitive profile names only, never rules or reasons` |
| SD-60 | MUST | Boot observability for flows: the summary of SD-37 adds one info line per `flow:<flow>` and `flow:<flow>#<stepId>` subject that has a non-baseline policy (subject, profile names, pack versions, rule counts, `apply` mode), one warn line per `mask-payload` step (subject, reason) and one per `redact: false` tap (subject, reason). No rule body, path or value is printed. | G the 18.3 example; W boot; T one info line each for `flow:loan`, `flow:loan#enrich`, `flow:loan#audit`, `flow:loan#credit`, `flow:loan#partner`, `flow:loan#send`, one warn line for `partner`, and no info line contains a field path (`ssn`, `**.pan`) or a rule body (the warn line holds the author's `applyReason` text verbatim) | `boot summary lists flow and step subjects without rules` |
| SD-61 | SHOULD | `SensitiveRuntime.stats()` returns monotonic counters of redactions by rule name, sink kind and subject, plus `[REDACTION_FAILED]` and `SENSITIVE_MASK_FAILED` counts, with no values, so an app can export them and spot false positives (R2) and silent rule gaps. | G the `pii` pack and 3 sink writes each holding one phone; W `stats()`; T the count for `pii.phone-e164`/`log`/subject is 3 and the object holds no phone | `runtime stats count redactions by rule, sink and subject without values` |
| SD-62 | SHOULD | Resilience events of a flow step, activator or binding (SPI-445) are sink copies of that subject: their error text, attributes and any payload go through `redactError`/`redact` with the subject's policy, and fallback values are never written to an event. | G a `handle` step with a resilience policy and a step `sensitive: { patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }] }`, failing with an error whose message holds `XSECRET1234`; W the retry event is emitted; T the event holds `[REDACTED:test.x]` and not `XSECRET1234` | SPI-445: `resilience events are redacted with the step policy` |
| SD-63 | MUST | `SagaRunnerOptions.sensitive.policy` accepts a `SensitiveRef`. Profile names resolve only through `runtime`; a name without `runtime` throws `SensitiveConfigError` (`UNKNOWN_PROFILE`) when the runner is built. | G a runner with `policy: 'pii'` and no `runtime`; W `new SagaRunner(...)`; T it throws `UNKNOWN_PROFILE`; with `runtime` the ledger write masks a phone | `saga policy names resolve only with a runtime` |
| SD-64 | MUST | The L4 references outside flows take a `SensitiveRef` and obey 18.2: `ActivatorOptions.sensitive`, `InboundSpec.sensitive`, the new `InboundDefaults.sensitive`, `OutboundRestOptions.sensitive`, and `bindGrpcOut(..., { sensitive })` (shape here; SPI-430 wires its sinks). `InboundDefaults.sensitive` applies to every inbound endpoint between module and channel. | G `forRoot({ sensitive: { profiles: { pii: { packs: ['pii@1'] } } }, inbound: { sensitive: 'pii' } })` and a request/reply `@InboundRest` endpoint without `sensitive`, with `idempotency: { storeMode: 'redacted', onDuplicate: 'envelope' }`, whose reply holds an email; W a request with an idempotency key; T the stored S6 record's `cachedResult` hashes or masks the email and the caller's reply holds it intact (an inbound handler's own throw reaches Nest's handler, not error.channel, section 1.3) | `inbound defaults, activator and binding references resolve by name` |
| SD-65 | MUST | Backward compatibility of the DSL: with no flow option, no step option and no profile set, every step's `describe()` output, the graph snapshot, the tap copy (same payload reference), the error envelopes and the delivered messages are exactly as in 0.9.0, and no resolver work runs per message (SD-36 holds). | G the existing flow, graph and insurance example suites; W they run on the new build; T they pass unmodified, and a redactor spy records zero calls on a successful flow with hop logging off | `compat: flow DSL without options keeps 0.9.0 describe output, tap copies and envelopes` |
| SD-66 | SHOULD | The boot inbound-discovery warn line (`integration.module.ts:347-350`, `String(error)`), a sink missing from the 0.3 table (S15, Estela-written but boot-time only), goes through `redactText` like S5. | G a discovery error whose message holds `https://u:p@h/x?token=SECRET`; W boot; T the warn line holds neither `u:p@` nor `SECRET` and boot continues | `inbound discovery warn line is redacted` |
| SD-67 | MUST | Shared scaffolding owner. SPI-433 is the first library ticket of the agreed delivery order (section 12), so it ships the parts of the shared flow parameter model that every concern needs: `IntegrationFlow.from(source, options?: FlowOptions)` with `BuiltFlow.options`, `StepCommonOptions` on every step except `reply` (which takes `id` only), `FlowTarget`/`FlowDest` on `fanoutTo`/`jumpTo`, the `jump(channel, { wait?, timeoutMs?, id?, sensitive? })` options, `ProfileName`, `FlowParameterFinding`, `FlowDefinitionError` and the `FlowParameterResolver` skeleton at the boot position of 7.1. Each type carries only the `sensitive` members here; SPI-429 adds the `idempotency` members (MR section 16.3) and SPI-445 the `resilience` members (RS section 3.10), with the same names and shapes, and neither re-creates the scaffolding. The rules are not restated here: the step id default and `DUPLICATE_STEP_ID` are owned by RS-57, the resolver position and the error class rule by RS-67, the graph `id` key by RS-66 (Q17). This resolves MR OQ-14 for the resolver; the model file location stays Q12. | G the SPI-433 build without SPI-429 or SPI-445; W a flow is built with two steps `{ id: 'x' }`; T flow build fails with `FlowDefinitionError` and a `DUPLICATE_STEP_ID` finding; G `from('a', { sensitive: 'pii' })` with profile `pii`; T it boots and resolves the L3 plan; G the existing flow, graph and insurance suites; T they pass unmodified (SD-65) | `shared flow parameter scaffolding ships with SPI-433 and keeps 0.9.0 behaviour` |

### 18.5 Failure and edge behaviour

| Situation | Behaviour | Requirement |
|---|---|---|
| Unknown profile name at L2..L4 | boot fails, finding `UNKNOWN_PROFILE` with subject and path | SD-48, SD-55 |
| Unknown profile name at L5 | that call rejects before sending | SD-56 |
| Profile cycle or depth above 8 | boot fails | SD-48 |
| `sensitive: false` at L2..L5; `false` at L1 with lower references | boot (L5: call) fails | SD-49 |
| `mask-payload` at L1..L3, on `filter`, `wireTap`, `route` or `reply`, or without `applyReason` | boot fails, `MASK_PAYLOAD_LEVEL` | SD-50 |
| `mask-payload` cannot produce a faithful copy | step fails with `SENSITIVE_MASK_FAILED`, non-retryable, nothing sent | SD-51 |
| `redact: false` without `redactReason` under an explicit policy | boot fails | SD-52 |
| `storeMode` at L3 or on a step/target | boot fails, `STORE_MODE_LEVEL` | SD-58 |
| `route` resolves a channel that has no `ChannelSpec` | its L2 is empty; L1, source L2, L3 and L4 still apply | SD-55 |
| The same channel appears twice in one `fanoutTo` with different `sensitive` | each target keeps its own plan | SD-47 |
| A tap subscriber mutates its copy | under copy-on-write, unchanged subtrees are shared with the main path (as the whole payload is in 0.9.0); not an isolation boundary (R13) | SD-52 |
| `mask-payload` with `hash` mode delivers tokens downstream | allowed; tokens change on salt rotation (R14) | SD-50 |
| Mixed resilience and sensitive error findings at boot | one throw whose `findings` lists all; class per RS-67 (Q14) | SD-55 |

### 18.6 Migration

- 0.9.0 apps: nothing to change (SD-65).
- Apps already on an SPI-433 pre-release with `ChannelSpec.sensitive` objects: unchanged; an object is
  a valid `SensitiveRef`.
- Moving repeated inline policies into `profiles` is a refactor with no output change, except where
  the move turns a module object from rules to profiles-only (SD-57): durable scopes then go back to
  `plain` and taps to shared copies. The boot summary (SD-37, SD-60) shows the change.
- Opting a flow into a policy turns its taps to redacted copies (SD-52); subscribers that need raw
  data must set `redact: false` with a reason.
