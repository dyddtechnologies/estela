# Estela: sensitive-data policy spec

Status: draft, not implemented. Base: `20ae298` (`chore(release): 0.9.0`), branch
`docs/SPI-428-koletz-readiness-specs`. Ticket: **SPI-433** (epic SPI-428). Requirement prefix: `SD-`.
Ships first in the SPI-428 series (highest risk). Release type: minor (`feat`), with three `fix`
commits for the leaks in section 0.3 (S3, S11, S12).

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
- Broker-backed channels (SPI-434) and resilience policies (SPI-RES, the resilience ticket still to be
  opened under SPI-428, `RS-` requirements; Q10). No rule here depends on them. This ticket adds no retry loop and
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
| Hop and error logs | S1, S2, S3, S5 |
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
  key headers masked, since the baseline has no salt), on S1, S2, S3 and S5 only (D3). A later
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
  the resilience policy model belongs to SPI-RES (RS-34).
- **Migration when a team opts in.** Setting any `sensitive` object changes the default `storeMode`
  of every durable scope it reaches to `status-only` (D5). Visible effects: request/reply endpoints
  with `onDuplicate: 'replay'` fail boot until they choose a `storeMode` (SD-30), and activator
  duplicates stop re-sending cached replies (SD-34). Boot lists every scope whose `storeMode` was
  defaulted (SD-29), so the change is seen at deploy time, not at the first duplicate. Recipe in the
  README: start with `storeMode: 'plain'` plus `storeModeReason` per scope, then tighten.

## 3. Requirements

RFC 2119 keywords. Every requirement has one acceptance criterion and at least one named test
(section 10). File paths are under `src/` unless stated.

| ID | Level | Statement | Acceptance (Given / When / Then) | Test |
|---|---|---|---|---|
| SD-01 | MUST | Without a `sensitive` option, behaviour is as in section 2: stores, replies, ledger and delivered messages unchanged; log sinks apply the baseline. `sensitive: false` restores 0.9.0 log text except for the three fixes (SD-04, SD-05, SD-43). | G an app on 0.9.0 config; W the inbound, activator, flow and saga suites run; T records and replies deep-equal 0.9.0, and S1/S2/S3/S5 text differs only where a `secrets@1` rule or the header denylist matched or one of the three fixes applies | `compat: no sensitive option keeps records, replies and messages identical`; `compat: sensitive false keeps 0.9.0 log text` |
| SD-02 | MUST | Redaction produces a copy for a sink; it never mutates the input, and the message delivered to activators, flows and remote services and the error thrown to callers are the originals. | G a deep-frozen payload with secrets; W every sink writes; T no `TypeError` from frozen writes, the activator receives the same reference, the thrown error keeps its original `message` | `redactor never mutates its input (deep-frozen payload)`; `activator receives the original payload while sinks get redacted copies` |
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
| SD-17 | MUST | Levels go from outer to inner: module, channel, endpoint/binding/activator/saga, call. Field, header and pattern lists are unions. For the same path the stricter mode wins (`remove` > `mask` = `replace` > `length` > `hash` > `partial`); between two modes of equal strength the outer level's wins. An inner level cannot remove or weaken an outer rule except through `allow` (SD-18). | G module `mask` on `**.token` and endpoint `partial` on `token`; W the endpoint writes a sink; T `token` is masked; G module `replace: 'x'` and channel `mask` on the same path; T the output is `x` | `merge: unions, stricter mode wins, inner levels cannot weaken, ties keep the outer mode` |
| SD-18 | MUST | `allow: [{ path, mode?, reason }]` weakens or removes an outer rule for one path at one level and the levels inside it; `reason` is required (1..200 chars); every exception is logged at boot at warn level with level, path, mode and reason; an `allow` that matches no outer rule logs a warning. The allowed path's value is written with the allowed `mode` (or as-is when `mode` is undefined) and pattern rules skip it. | G an endpoint field rule `from` plus `allow: [{ path: 'from', mode: 'partial', reason: 'business sender number' }]` under `pii`; W boot, then a payload with `from: '+50212345678'` is written to S3; T one warn line with the four fields, and `from` is partial (`keepFirst`/`keepLast` of 6.3), not hashed by the pattern; the same entry without reason fails boot | `allow exceptions need a reason, are logged at boot and win over patterns` |
| SD-19 | MUST | With the default JavaScript engine, every pattern is validated at boot and rejected when it has nested unbounded quantifiers, a quantified alternation whose branches share a first character, adjacent unbounded quantifiers over overlapping sets, a backreference, the sticky flag, or can match a zero-length string at any position (decided on the parsed pattern, not by probing an empty input). A pattern without the `g` flag is recompiled with it. | G `(a+)+`, `(a\|ab)*`, `\d+\d+`, `(\w+)\1`, `/x/y`, `a*`, `\b`, `(?=x)`; W boot; T each fails boot with the pattern name and the reason; `/AKIA[0-9A-Z]{16}/` passes | `regex safety rejects catastrophic and zero-length patterns` |
| SD-20 | MAY | A `RegexEngine` port (for example an adapter over `re2`, injected by the app) compiles every rule; with it the backtracking analysis is skipped and syntax the engine rejects fails boot. Estela does not import `re2`. | G a fake engine that rejects lookbehind; W a user rule with lookbehind is compiled; T boot fails naming the rule | `regex engine port compiles every rule and reports rejects at boot` |
| SD-21 | MUST | A string longer than `maxScanBytes` (UTF-8, default 65536, range 1024..16777216) is cut in the sink copy: the first `maxScanBytes` (rounded down to a code point boundary) are scanned; then the copy drops the run of non-whitespace characters that reaches the cut, and at least the last 512 bytes of the window, and appends `[truncated N bytes]`. A secret straddling the cut is never partially emitted, whatever its length; a window with no whitespace is dropped whole. | G a 70 KiB string where a 2 KiB JWT starts 1 KiB before the 64 KiB mark; W written to S3; T no substring of the JWT longer than 8 chars appears and the marker reports the dropped size; G a 70 KiB base64 blob without whitespace; T the copy is the marker only | `long strings are cut after scanning, dropping the token that reaches the cut` |
| SD-22 | MUST | The walker stops at `maxDepth` (default 32) and `maxNodes` (default 10000) with `[TRUNCATED]`, writes `[Circular]` for cycles, never invokes getters (`[Getter]`) or `toJSON` (except `Date`, written as its ISO string), writes `[Binary len=N]` for `Buffer`/`Uint8Array`/`ArrayBuffer`, and walks `Map`/`Set` as entries/values. | G a payload with a cycle, a getter that throws, an object whose `toJSON` throws, a Buffer holding a secret, a `Date` and depth 40; W redacted; T no throw, no secret, the four placeholders appear and the date is an ISO string | `walker limits: depth, nodes, cycles, getters, toJSON, binary, Map and Set` |
| SD-23 | MUST | If redaction itself throws, the sink writes `[REDACTION_FAILED]` in place of the value, the business path continues, and one error line without data is logged (rate-limited to one per sink per minute). | G a selector compiler bug simulated by a throwing rule; W a sink writes; T the sink holds the placeholder and the flow completes | `redaction failure writes a placeholder, never the raw value` |
| SD-24 | MUST | False-positive policy. A pattern rule may declare `accept(match, input, offset)`, run in code after the regex matches; a rejected match is left as-is and the scan resumes after it. `pii.phone-e164` matches `\+[1-9]\d{7,14}` and its `accept` rejects a match preceded or followed by a digit; `pii.card` accepts only the issuer prefixes and lengths of section 6.4 with a valid Luhn check and no adjacent digit. Context is checked in code, never consumed by the regex, so adjacent values are all matched. Over-masking is accepted; each rule has `skipKeys`; protected trace fields are never scanned (SD-10). | G the strings `1731150000000`, `+05:30`, `+0000`, `+123`, `+5021234567890123456` (19 digits), a fixed list of 18- and 19-digit ids that each lack an issuer prefix or fail Luhn, and `call +50212345678 +50287654321`; W the `pii` pack runs; T only the two numbers in the last string are redacted, both of them | `pii false-positive corpus: timestamps, ids, offsets`; `adjacent phone numbers are both redacted` |
| SD-25 | MUST | The `pii` E.164 rule uses hash-or-mask (D-PHONE: customer numbers are hashed when a salt exists); apps keep `partial` for their own business/sender numbers through a field rule plus an `allow` with reason (SD-18). | G `pii` and a SaltProvider; W `+50212345678` appears in an error message; T it is written as `h:<id>:<hex>`; without a SaltProvider it is `[REDACTED:pii.phone-e164]` | `pii phone rule hashes by default` |
| SD-26 | MUST | Mask tokens name the rule that fired: `[REDACTED:<rule>]` (`header` for the denylist, `field` for unnamed field rules). Rule names come from configuration only and match `^[a-z0-9][a-z0-9._-]{0,63}$`. | G a rule named `My Rule!`; W boot; T boot fails; a rule `pii.email` produces `[REDACTED:pii.email]` | `mask tokens name the rule; invalid names fail boot` |
| SD-27 | MUST | Sinks S1, S2, S3, S5, S6, S7, S8, S9 (when the saga runner has a policy), S10 (when `redact: true`), S11, S12 and S14 apply the effective policy of their channel/endpoint/binding/activator/saga. | G every Estela entry and exit wired in one app with a policy, logging at debug; W the leak e2e drives success, failure, duplicate and replay paths; T `expectNoLeak` passes for all secrets in all forms | `test/sensitive-leak.e2e.spec.ts: no secret reaches any sink at debug level` |
| SD-28 | MUST | `wireTap(channel, { redact: true })` delivers a redacted copy (same `id`, copied history); without the option it keeps the 0.9.0 shared-payload copy. | G a flow with `.wireTap('audit', { redact: true })`; W a message with a token passes; T the audit subscriber sees the mask and the main path sees the token | `wireTap redact delivers a redacted copy` |
| SD-29 | MUST | `storeMode` resolves per durable scope (inbound endpoint, activator, saga): an explicit value wins; otherwise `plain` when no explicit `sensitive` object reaches the scope (the baseline does not count) and `status-only` when one does (module level included). Sagas only get a policy through `SagaRunnerOptions.sensitive` (D7). Flow scopes have no `storeMode`: their records hold no payload (`{ completed }`/`{ filtered }`), and under a policy their failure records hold the redacted error. Boot logs one warn line per scope whose `storeMode` was defaulted to `status-only`. | G a module policy, an endpoint and an activator without `storeMode`; W boot and one request; T the record is status-only and boot logged one warn line for each of the two scopes; without the module policy the record is plain and no line is logged | `storeMode default: plain without policy, status-only with one, defaulted scopes listed at boot` |
| SD-30 | MUST | The interaction matrix in section 8.2 holds; a request/reply inbound with `onDuplicate: 'replay'` whose resolved `storeMode` is `status-only` fails boot, naming the endpoint. | G that endpoint; W boot; T `SensitiveConfigError` with the channel name; with `storeMode: 'encrypted'` boot passes | `status-only plus replay on request/reply fails boot`; one test per matrix row (section 10.1, group G) |
| SD-31 | MUST | `encrypted` seals records with AES-256-GCM (random 96-bit IV, key from `KeyProvider`, AAD = `estela:v1:<scope>::<key>`) into `{ estelaSealed: { v: 1, kid, iv, tag, ct } }`; a record that fails authentication (tampered, or copied to another key) raises a non-retryable `SensitiveRecordError` and is never re-run. | G a sealed record moved to another storage key; W a repeat reads it; T `SensitiveRecordError`, the handler is not called | `sealed records: round trip, tamper, key swap` |
| SD-32 | MUST | D-REDIS-DOWN applied to keys. For an `encrypted` scope Estela calls `KeyProvider.current()` before it claims the key (inbound `begin`, activator `begin`, before the saga's first unit) and seals with that key; when it fails, nothing is claimed or dispatched and the caller gets a retryable `SensitiveKeyUnavailableError`. When `byId()` throws on a repeat the request fails with the same retryable error and is not re-run; when `byId()` returns `undefined` it fails with a non-retryable `SensitiveReplayUnavailableError`. There is no fail-open setting for encrypted scopes (D-REDIS-DOWN, D13). | G a KeyProvider whose `current()` throws; W a new request with a key arrives; T the handler's channel receives nothing, the error is retryable and the store holds no record for the key | `key provider down at claim fails closed before dispatch`; `key provider down at replay never re-runs`; `retired key gives replay unavailable` |
| SD-33 | MUST | `SagaRunnerOptions.sensitive` sets the ledger `storeMode`. The data key is fetched before the first unit (SD-32), so no provider call runs inside a database transaction; sealing runs inside the unit's transaction before `record`. On a status-only replay the runner returns `replyOnReplay(ctx)` when given, else throws `SensitiveReplayUnavailableError`. | G a status-only saga without `replyOnReplay`; W the same key runs twice; T the second run throws it and no step runs; G an encrypted saga with a spy KeyProvider; T `current()` is called before `transactions.run` and never inside it | `saga ledger: encrypted round trip, key fetched outside the transaction`; `saga ledger: status-only replay` |
| SD-34 | MUST | An activator duplicate whose record is status-only and whose message has a reply channel sends no reply and logs one warn line with the scope (never the key). | G an activator scope with a status-only record; W a duplicate with `replyChannel` arrives; T no reply is sent and one warn line names the scope | `activator duplicate on a status-only record warns and does not reply` |
| SD-35 | MUST | The `IdempotencyStore` and `IdempotencyLedger` contracts are unchanged; sealed and status-only records survive a store that round-trips records through `JSON.stringify`/`JSON.parse`. | G a JSON-serializing fake store; W encrypted and status-only records are written and replayed; T replays work | `sealed and status-only records survive a JSON store` |
| SD-36 | MUST | Redaction is lazy: no walk, scan or hash runs unless a sink is about to write; with hop logging off and no failure, the redactor is never called. | G a module policy and `logging.hops: false`; W 1000 successful requests on a fire-and-forget endpoint (its records are `{ accepted, id }` and are never encoded, section 7.3); T the redactor spy records zero calls | `redactor is not called when no sink writes` |
| SD-37 | MUST | Boot validation collects every configuration problem and throws one `SensitiveConfigError` listing them; on success one info line per policy scope summarises it (scope, counts, pack versions, storeMode, salt id) with no rule bodies or data. | G three independent config errors; W boot; T one error lists all three | `boot reports all configuration errors at once`; `boot summary line has no data` |
| SD-38 | MUST | `@estela/nest/testing` exports `captureSinks()` and `expectNoLeak()` (section 4.9). The corpus checks plain, base64 and base64url at the three byte alignments, `encodeURIComponent`, form encoding, JSON-escaped and double JSON-escaped forms; secrets shorter than 8 chars are refused; a failure names the sink, the form and a SHA-256 prefix of the secret, never the secret. | G a secret written base64-encoded at offset 1 inside a log line; W `expectNoLeak` runs; T it fails naming sink `log`, form `base64@1` and the hash prefix | `expectNoLeak finds every encoded form`; `expectNoLeak never prints the secret` |
| SD-39 | SHOULD | The module provides `SensitiveRuntime` as an injectable provider whose `redactForLog(value, { channel? })` and `redactError(error, { channel? })` use the compiled module policy, for app code (exception filters, app loggers). There is no process-global runtime: two modules in one process keep separate policies. | G an exception filter that injects `SensitiveRuntime`, and two test apps with different policies in one process; W an upstream error with a token is caught in each; T each filter's line is masked by its own app's policy | `SensitiveRuntime is injectable and scoped to its module` |
| SD-40 | MUST | No runtime dependency is added; `src/sensitive/` imports no npm package (new depcruise rule `sensitive-no-npm`, `node:` modules allowed); the domain files keep their rule; d.ts stays TS 4.9-parseable. | G the build; W `npm run verify`; T depcruise and `dist-typescript4` pass | depcruise `sensitive-no-npm`; `test/dist-typescript4.spec.ts` |
| SD-41 | SHOULD | Overhead is measured, not assumed: a benchmark (payload sizes, rule counts, packs, engines) is added under SPI-444, which sets the budgets. | G SPI-444; W the benchmark runs; T results are published and budgets recorded there | SPI-444 `bench/sensitive.bench.ts` |
| SD-42 | MUST | Salt and key material, rule bodies and allow-listed values are never written to any sink, including boot lines and `SensitiveConfigError` messages. | G a misconfigured 16-byte salt; W boot fails; T the error text holds the salt id and length, not the bytes | `config errors and boot lines never print salt or key material` |
| SD-43 | MUST | Estela's own errors keep idempotency keys out of `message`: `IdempotencyInProgressError.message` is `IDEMPOTENCY_KEY_IN_PROGRESS: <scope>`. Their key-bearing own properties (`IdempotencyInProgressError.key`, `InboundIdempotencyInFlightError.clientKey`) are written by every sink with the idempotency-key treatment of SD-09 (hash-or-mask), baseline included. | G a saga run from an activator with a key `K-555` whose first run is in progress; W the duplicate throws and reaches error.channel; T `message` and the S3 line hold no `K-555`, and `error.key` on the thrown error is still `K-555` | `in-progress errors keep the key out of message and sinks` |
| SD-44 | MUST | Inbound endpoints that boot discovery skips (`integration.module.ts:347-350` logs and continues) are validated when their plan is built at the first request: a configuration problem there throws `SensitiveConfigError` for that request, before any claim, and is logged once per endpoint. | G an endpoint whose policy has an invalid selector and whose discovery is made to fail; W its first request arrives; T the request fails with `SensitiveConfigError`, nothing is claimed, and a second request fails the same way with no second log line | `inbound policy missed by discovery is validated at first plan build` |

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
SD-32 and the caller's retry layer decides (SPI-RES: RS-17a classifies it `'transient'`, RS-28 to
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
  /** Compiled at module init; throws SensitiveConfigError with every problem found. */
  static compile(options: SensitiveModuleOptions | false | undefined, scopes: ScopePolicies): Promise<SensitiveRuntime>;
  redact<T>(value: T, ctx: RedactContext): unknown;
  redactError(error: unknown, ctx: RedactContext): { name: string; message: string; stack?: string; [k: string]: unknown };
  redactText(text: string, ctx: RedactContext): string;
  storeModeOf(scope: string): StoreMode;
  rotateSalt(): Promise<void>;
  /** For app code (SD-39): the module policy, sink kind 'log'. */
  redactForLog(value: unknown, ctx?: { channel?: string }): unknown;
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
| `channel-factory.ts` | `ChannelSpec.sensitive?: SensitivePolicy` |
| `inbound/inbound.types.ts` | `InboundSpec.sensitive?`; `InboundIdempotencyOptions.storeMode?: StoreMode` |
| `inbound/inbound.idempotency.ts` | `InboundIdempotencyPlan.codec` gains `records: RecordCodec`; `claim` calls `prepare()`; `succeed`/`settle` encode; repeats decode (section 7.3) |
| `inbound/inbound.failure.ts` | `statusOnlyFailure(serialized)` keeps `{ kind, status }` or `{ kind, name }`; `clientKey` of `InboundIdempotencyInFlightError` declared key-bearing (SD-43) |
| `saga/idempotency-ledger.ts` | `IdempotencyInProgressError.message` without the key; `key` declared key-bearing (SD-43) |
| `decorators.ts` | `ActivatorOptions.sensitive?: SensitivePolicy` |
| `activator/activator-wrapper.ts` | records through `RecordCodec`; SD-34 warning |
| `flow/flow-executor.ts` | stored failure redacted; error envelope `error` redacted when a policy applies (raw only with `sensitive: false`) |
| `flow/integration-flow.ts`, `flow/steps/wire-tap.step.ts` | `wireTap(channel, options?: { redact?: boolean })` |
| `outbound/outbound.types.ts` | `OutboundRestOptions.sensitive?: SensitivePolicy` (module defaults and bindings) and `OutboundRestCallOptions.sensitive?: SensitivePolicy` (call level) |
| `adapters/rest.adapter.ts` | message uses `redactUrl` (SD-05) |
| `saga/saga-runner.ts` | `SagaRunnerOptions.sensitive?: { policy?: SensitivePolicy; storeMode?: StoreMode; keys?: KeyProvider; runtime?: SensitiveRuntime; replyOnReplay?: (ctx: unknown) => unknown }` |
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
| inbound endpoint `inbound:<channel>` | module, channel, `InboundSpec.sensitive` |
| activator `activator:<Class>.<method>` | module, channel, `ActivatorOptions.sensitive` |
| flow `flow:<name>` | module, source channel |
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
  every write goes through `SensitiveRuntime` or the disabled path (SD-23, SD-27).
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
`retryable: true`; SPI-RES decides which layer retries (RS-17a, RS-28) and how the budget propagates
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

### 10.2 End-to-end and build tests

- `test/sensitive-leak.e2e.spec.ts: no secret reaches any sink at debug level` (SD-27): one Nest app
  on loopback with an inbound REST request/reply endpoint (each storeMode), a fire-and-forget endpoint,
  activators, a flow with a redacted wire tap, an outbound REST binding against a local server that
  echoes the key in its error body, a saga with a memory ledger, logging `hops: true` at `debug`; drives
  success, failure, duplicate and replay; `expectNoLeak` over the capture with a JWT, an API key, a
  phone, an email, a card number and an idempotency key. The leak e2e uses only the in-memory store
  and ledger; Redis/Postgres stores are covered by SPI-429's contract suite, which reuses
  `sealed and status-only records survive a JSON store` (SD-35).
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
   ├──► SPI-RES (RS-, key still to open, Q10): classifies SensitiveKeyUnavailableError
   │    (retryable) and SensitiveReplayUnavailableError / SensitiveRecordError (terminal), owns
   │    the retry budget
   └──► Koletz adoption spec (KA-): its pack, header additions, per-channel table, salt and key
        providers, and the D-PHONE choice per channel
```

### Agreed delivery order (identical in the four SPI-428 specs)

1. **SPI-433 sensitive data (P0)** ships first. With SPI-432 (graph control, P0) it gates the first
   Koletz adoption step (A1).
2. **SPI-429 multi-replica (P1).** Its boot guard is released and enabled in Koletz (KA-01, KA-02)
   before any service runs more than one replica or an HPA; until then the Koletz CI check KA-03
   blocks scaling. It does not gate A1.
3. **SPI-RES resilience** after SPI-429, so RS-50 lands with the guard instead of as a follow-up;
   SPI-430 and SPI-436 merge after it or rebase onto it.
4. **Koletz adoption (KA-)**, gated by the P0 items: A1 by SPI-433 + SPI-432; A4 by SPI-433 +
   SPI-431; A3 by SPI-RES (plus SPI-430 / SPI-436 for gRPC and SDK hops); A7 (shared store, scaling
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
| Q10 | Open the resilience ticket under SPI-428 and give its key, so section 12 and the error classification can name it | Referenced as `SPI-RES` (placeholder, RS OQ-1) | Platform owner |
| Q11 | Confirm the `secrets.keys` key list (R12) | As in 6.4 | ESTELA maintainer |

## 16. Definition of done

- All MUST requirements implemented; SD-20 and SD-39 implemented or explicitly deferred in the PR.
- Every test named in section 10 exists and passes; `npm run verify` green; `npm run comments:en`
  green on touched files; CI jobs green.
- Leak e2e passes at debug level with all four storeModes.
- README, AGENTS.md and skills updated (section 11) in the same PR.
- No runtime dependency added; `sensitive-no-npm` rule in place.
- PR description per template, with `BREAKING CHANGE` absent (additive) and the three `fix` items listed.
- Open questions Q1 to Q11 answered or carried to tickets; Q9 is already resolved (MR-20 retired,
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
| SD-32 | `key provider down at claim fails closed before dispatch`; `key provider down at replay never re-runs`; `retired key gives replay unavailable` | SPI-433 (retry layer: SPI-RES, RS-17a) |
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
