<div align="center">
  <img src="assets/estela-banner.svg" alt="ESTELA — EIP runtime for NestJS" width="100%" />

  **The Enterprise Integration Patterns runtime for NestJS.**
  *The flow talks to channels, not to classes.*

  [![tests](https://img.shields.io/badge/tests-421%2F421-brightgreen)](#status)
  [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](#architecture)
  [![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](#installation)
  [![NestJS](https://img.shields.io/badge/NestJS-10%20%7C%2011-E0234E?logo=nestjs&logoColor=white)](#installation)
  [![license](https://img.shields.io/badge/license-MIT-blue)](#license)
  [![website](https://img.shields.io/badge/DYDD_Technologies-dyddtech.com-0A66C2)](https://www.dyddtech.com)
  [![LinkedIn](https://img.shields.io/badge/LinkedIn-eliudiaz-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/eliudiaz)
  [![maintainer](https://img.shields.io/badge/maintainer-eliudiaz--dydd-181717?logo=github)](https://github.com/eliudiaz-dydd)

  **English** · [Español](./README.es.md) · [Português](./README.pt.md) · [Français](./README.fr.md)

  [Installation](#installation) · [Quick start](#quick-start) · [Channels](#channels) · [Flow DSL](#flow-dsl) · [Tracing](#tracing--idempotency) · [Inbound adapters](#inbound-adapters-reply-mapping--idempotency) · [Observability](#observability) · [Architecture](#architecture)
</div>

---

## Why ESTELA

**Estela** *(Spanish for “trail” — the wake a comet leaves behind)*: every message
traveling through the runtime leaves a trail — `traceId`, `spanId`, a `history` of
hops — and every hop is a point in that trail. Spring Integration semantics, native to Node:

- **4 in-memory channels** with real EIP semantics: `direct` · `queue` · `pubsub` · `fanout`.
- **Fluid flow DSL** with 10 patterns: `filter → transform → wireTap → fanoutTo → jumpTo → publish → route → to → reply`.
- **Request/reply** with ephemeral channels and race-free timeouts (`AbortSignal.timeout`).
- **Tracing** via `AsyncLocalStorage`, with context rebuilt from headers at every hop.
- **Idempotency** with `flow:*` / `activator:*` scopes and a swappable store (memory or Redis).
- **Inbound REST / gRPC / Rabbit / GraphQL** declared on controllers, never in `forRoot`.
- **Live topology graph**: JSON + Mermaid, two endpoints.
- **100% native**: messaging with zero runtime dependencies. Brokers are ports.

```mermaid
flowchart LR
  subgraph ESTELA
    direction LR
    IN["@InboundRest / gRPC / GraphQL / Rabbit"] --> C["Channels\ndirect · queue · pubsub · fanout"]
    C --> F["FlowEngine\nfilter · transform · fanout · jump · reply"]
    F --> A["@ServiceActivator\nyour class, wired in"]
    A --> OUT["Outbound\nREST · gRPC · Rabbit"]
    F -.trace + idempotency.-> C
  end
```

## Installation

```bash
npm install https://github.com/dyddtechnologies/estela/releases/download/v0.1.0/estela-nest-0.1.0.tgz
```

> Distributed as a **GitHub Release artifact** (packed tarball) — no npm registry needed.
> Peers: `@nestjs/common/core` ^10‖^11 · `@nestjs/swagger` ^7‖^8 · `reflect-metadata` · `rxjs`.
> Optional (typed/adapters only, **never** in the barrel): `amqplib` · `@grpc/grpc-js` · `@nestjs/graphql`.

## Quick start

```ts
@Module({
  imports: [
    IntegrationModule.forRoot(
      {
        channels: [
          { name: 'orders.place', type: 'direct' },
          { name: 'orders.audit', type: 'queue', capacity: 10_000 },
          { name: 'domain.events', type: 'pubsub' },
          { name: 'ops.fanout', type: 'fanout', bindings: ['inventory.reserve', 'billing.charge'] },
        ],
        idempotency: { enabled: true },
      },
      [PlaceOrderFlow],
    ),
  ],
  providers: [InventoryActivator],
})
export class AppModule {}
```

```ts
export const PlaceOrderFlow: FlowDefinition = {
  name: 'place-order',
  build: () =>
    IntegrationFlow.from('orders.place')
      .filter((p) => (p as { qty: number }).qty > 0)
      .transform((p) => ({ orderId: 'ord-1', ...(p as object), total: (p as { qty: number }).qty * 10 }))
      .wireTap('orders.audit')                                      // fire-and-forget, never fails
      .jumpTo([{ channel: 'inventory.reserve', timeoutMs: 3_000 }]) // wait → jumpReplies
      .publish('domain.events', 'order.placed')
      .reply()                                                      // closes the HTTP reply if present
      .to('orders.persist'),
};
```

```ts
@Injectable()
export class InventoryActivator {
  @ServiceActivator('inventory.reserve')
  reserve(payload: unknown): string {
    return 'reserved'; // the wrapper answers the hop's replyChannel (jumps included)
  }
}
```

```ts
@Controller('orders')
export class OrdersController {
  @Post()
  @InboundRest({ channel: 'orders.place', requestReply: true, timeoutMs: 5_000 })
  place(@Body() dto: PlaceOrderDto): void {} // → { status:'ok', result, headers }
}
```

## Channels

| Kind | Semantics |
|---|---|
| `direct` | 1 subscriber · `send` awaits the handler · no subscriber → throws |
| `queue` | FIFO buffer + round-robin · capacity · overflow → error (never a silent drop) |
| `pubsub` | broadcast · `*`/`#` glob routing keys · round-robin groups · per-subscriber fault isolation |
| `fanout` | Composite: copies to bindings + subscribers · awaited or forget · **A↔B cycle guard** |

## Flow DSL

| Step | Semantics |
|---|---|
| `filter` | exits successfully (idempotency `{filtered:true}`) |
| `transform` / `handle` | replace the payload; `handle` never triggers a reply |
| `wireTap` | fire-and-forget copy; swallows errors |
| `fanoutTo` | awaited group in parallel; `wait:false` → forget → `error.channel` |
| `jumpTo` / `jump` | own ephemeral channel · awaits reply + timeout · `jumpReplies[channel]` |
| `publish` | `nextHop` + routingKey · does not cut the pipeline |
| `route` | dynamic `string \| string[]` · terminates |
| `to` | sends and **terminates** |
| `reply({payload})` | `'current'` \| `'jumpMerge'` → answers the `replyChannel` |

**`replyChannel` precedence** (runtime invariant): `wireTap/fanout/publish → none` ·
`to/route → inherit` · `jump → its own ephemeral`. The parent always keeps the inbound reply.

## Tracing & idempotency

| Header | Message field |
|---|---|
| `x-trace-id` / `x-span-id` / `x-parent-span-id` | `traceId` · `spanId` · `parentSpanId` |
| `x-correlation-id` / `x-causation-id` | `correlationId` · `causationId` |
| `idempotency-key` / `x-idempotency-key` | `idempotencyKey` |

Scopes: `flow:${name}` · `activator:${Class}.${method}` · storage key `${scope}::${key}` ·
no key → no-op · `enabled:false` → Null Object.

<details>
<summary><strong>Implementing <code>IdempotencyStore</code> with Redis (contract only)</strong></summary>

```ts
export class RedisIdempotencyStore implements IdempotencyStore {
  private k = (scope: string, key: string) => `${scope}::${key}`;
  async begin(scope: string, key: string, ttlMs: number) {
    return (await this.redis.set(this.k(scope, key), 'in-flight', 'PX', ttlMs, 'NX')) === 'OK';
  }
  async complete(scope: string, key: string, result: Record<string, unknown>) {
    await this.redis.set(this.k(scope, key), JSON.stringify({ status: 'completed', result }), 'KEEPTTL');
  }
  async fail(scope: string, key: string, error: unknown) { /* KEEPTTL + failed status */ }
  async get(scope: string, key: string) { /* JSON → IdempotencyRecord | undefined */ }
  async purgeExpired() { return 0; } // native Redis TTL
  // Optional (0.6.0): lets inbound `onFailure: 'release'` free a key so the retry runs for real
  async release(scope: string, key: string) { await this.redis.del(this.k(scope, key)); }
}

forRoot({ channels, idempotency: { store: new RedisIdempotencyStore(redis) } });
```
</details>

## Inbound adapters: reply mapping & idempotency

`@InboundRest`, `@InboundGrpc` and `@InboundGraphQL` launch a flow from an annotated handler. Since
0.6.0 each endpoint can answer with **its own response contract** and apply **its own idempotency
rules**. Options go on the decorator, or module-wide in `forRoot({ inbound })`; an endpoint overrides
the module default, which overrides the built-in.

**With nothing configured, nothing changes**: the endpoint answers the estela envelope
(`{status:'ok'|'accepted'|'duplicate', …}`) and deduplicates on `idempotency-key` under the scope
`inbound:<channel>`, exactly as in 0.5.0.

### Reply mapping

```ts
@InboundRest({ channel: 'orders.place', requestReply: true, reply: 'raw' })   // just the flow result

@InboundRest({
  channel: 'wf.start', requestReply: true,
  reply: ({ result, payload, receivedAt }: InboundReplyContext<StartPayload, StartResult>) => ({
    data: { ...result, correlationId: payload.correlationId, responseTime: Date.now() - receivedAt },
    success: true,
  }),
})

// gRPC: answer the proto message shape
@InboundGrpc({
  channel: 'wf.complete', requestReply: true,
  reply: ({ result, payload }: InboundReplyContext<CompleteInput, CompleteResult>) => ({
    instanceId: result.instanceId ?? payload.instanceId,
    resultJson: JSON.stringify(result),
  }),
})

// A provider that injects services: pass a ref, never the bare class
@InboundRest({ channel: 'orders.place', requestReply: true, reply: { useExisting: OrderReplyMapper } })

IntegrationModule.forRoot({ channels, inbound: { reply: 'raw' } }, flows);     // module-wide default
```

| `reply` | request/reply | fire-and-forget (accepted) | repeated key (duplicate) |
|---|---|---|---|
| `'envelope'` (default) | `{status:'ok', result, …}` | `{status:'accepted', …}` | `{status:'duplicate', …}` |
| `'raw'` | the flow result | the handler return value | `{status:'duplicate', …}` |
| function · `{ mapReply }` · `{ useExisting }` | your shape | your shape | your shape |

A custom mapper receives an `InboundReplyContext`: `kind` (`'reply' \| 'accepted' \| 'duplicate'`),
`result`, `payload`, `rawHeaders`, `handlerResult`, the Nest `context`, `receivedAt`, `replayed`,
`duplicateOf`, `acceptedId`, the `message` and the `envelope` estela would have answered. It may be
async. It runs after the idempotency record is written, so a mapper that throws never releases or
fails the key.

### Idempotency options

```ts
@InboundRest({ channel, idempotency: false })            // no inbound claim for this endpoint
@InboundRest({ channel, idempotency: { /* options */ } })
IntegrationModule.forRoot({ channels, inbound: { idempotency: { /* options */ } } }, flows);
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` skips the claim. **Not inherited**: an endpoint that passes an options object is enabled unless it says otherwise, even when the module default is `false`. |
| `clientKey` | `idempotency-key`, `x-idempotency-key` | Where the client key comes from: a header name, a list of names (case-insensitive) or `(ctx) => string \| undefined`. |
| `key` | the client key | Storage-key resolver: function, `{ resolveKey }` or `{ useExisting }`. Receives `payload`, `rawHeaders`, `context`, `clientKey`. Returns a string (used verbatim), an array of parts (escaped and joined with `:`), `{ scope, key }`, or `undefined`/`null` to skip the claim. May be async. **May throw**: the request is rejected and nothing is claimed. It is called even when the client sent no key, so guard `clientKey`: an empty key or a part that is not a non-empty string or a finite number (`undefined`, `null`, `''`) is rejected with an `InboundError` instead of merging callers into one key. |
| `scope` | `inbound:<channel>` | Storage scope (storage key = `${scope}::${key}`). |
| `ttlMs` | module `idempotency.ttlMs`, else 1 h | TTL passed to `store.begin`. |
| `store` | the module `IdempotencyService` | An `IdempotencyStore` instance or `{ useExisting }`. |
| `onDuplicate` | `'envelope'` | `'replay'` answers a completed repeat **through the same reply mapper** as the first time. |
| `onInFlight` | `'duplicate'` | `'reject'` throws `InboundIdempotencyInFlightError`; a function returns the error to throw. |
| `onFailure` | `'keep'` | `'release'`, `'store'`, `'marker'`, or a classifier `(error, ctx) => 'keep' \| 'release' \| 'store'` (function, `{ classify }`, `{ useExisting }`). |
| `failureCodec` | `HttpExceptionFailureCodec` | `{ serialize, deserialize }` for stored failures. |
| `forward` | see [Forwarding](#forwarding-the-key-downstream) | `'raw' \| 'resolved' \| 'none'`. |

**A repeated key** (`store.begin` returned `false`):

| Stored record | `onDuplicate: 'envelope'` | `onDuplicate: 'replay'` |
|---|---|---|
| completed request/reply | duplicate (`result` = cached result) | mapped as `kind:'reply'`, `replayed:true` |
| completed fire-and-forget | duplicate (`result: null`) | mapped as `kind:'accepted'` with the stored message id |
| stored failure | rethrows the stored error | rethrows the stored error |
| failed and kept | duplicate (`duplicateOf:'failed'`, `result: null`) | same |
| still in flight | `onInFlight` | `onInFlight` |

**A failed dispatch** (the first run always rethrows the error it got, unchanged):

| Action | Store call | Next request with the same key |
|---|---|---|
| `keep` | `fail()` | answered as a duplicate until the TTL expires |
| `release` | `release()` | runs for real |
| `store` | `complete()` with the serialized failure | rethrows the deserialized failure |

How the action is chosen: `'keep'` (default) ignores everything. Any other `onFailure` first honours
a mark left on the error with `markInboundFailure(error, action)`; without a mark, `'marker'` keeps,
`'release'`/`'store'` apply (except to a `ReplyTimeoutError` or a `NoSubscriberError`, which are kept
because the flow may still be running or may have finished without being answered), and a classifier
decides. A flow on awaited channels that outlives `timeoutMs` surfaces as `ReplyTimeoutError`. The default codec round-trips a Nest `HttpException` (status
and body); any other error is replayed as `InboundReplayedFailureError`, which Nest renders as a 500.
No stack is stored.

### Multi-tenant example

```ts
@Injectable()
export class TenantKeyResolver implements InboundKeyResolver<CompletePayload> {
  constructor(private readonly steps: StepGuard) {}

  async resolveKey({ payload, clientKey }: InboundKeyContext<CompletePayload>) {
    await this.steps.assertCompletable(payload);      // a rejected request never claims a key
    if (clientKey === undefined) return undefined;    // no key sent: no idempotency
    return {
      scope: 'wf-complete',
      key: [payload.tenantId, payload.flowId, payload.stepId, clientKey],   // bound to the tenant
    };
  }
}

@Post(':flowId/steps/:stepId/complete')
@InboundRest({
  channel: 'wf.complete',
  requestReply: true,
  reply: 'raw',
  idempotency: {
    key: { useExisting: TenantKeyResolver },
    store: { useExisting: PgIdempotencyStore },       // your own IdempotencyStore provider
    onDuplicate: 'replay',                            // a repeat gets the first answer again
    onInFlight: () => new ConflictException('IDEMPOTENCY_KEY_IN_PROGRESS'),   // HTTP 409
    onFailure: 'marker',                              // the business code decides, per error
  },
})
complete(@Param() params: CompleteParams, @Tenant() tenantId: string, @Body() body: CompleteBody) {
  return { ...params, tenantId, ...body };            // the returned value is the flow payload
}

// Where the work happens (activator, saga…): say what a failure means for the key
throw markInboundFailure(error, committedLevels === 0 ? 'release' : 'store');
```

Two tenants sending the same `Idempotency-Key` now own two different storage keys, so neither can
receive the other's cached answer. A validation error releases the key and the retry runs; a
partially committed failure is stored and every retry gets the same HTTP error back.

### Forwarding the key downstream

`headers.idempotencyKey` of the dispatched message is what the `flow:<name>` and
`activator:<Class>.<method>` scopes deduplicate on.

| `forward` | Flow and activator scopes see |
|---|---|
| `'raw'` | the client key |
| `'resolved'` | the encoded storage key (tenant-bound when your resolver is) |
| `'none'` | nothing |

The default is `'raw'`. It becomes `'none'` as soon as `key` or an `onFailure` policy other than
`'keep'` is configured: a raw key downstream would let two tenants block each other at the flow scope,
and a key released at the inbound scope but still claimed by the flow would turn the retry into a
silent flow duplicate (a `ReplyTimeoutError`). For that reason an `onFailure` policy combined with an
explicit `'raw'` or `'resolved'` is rejected.

With the claim disabled (`idempotency: false`) nothing answers a repeat at the inbound scope, so the
default is `'none'` on a `requestReply` endpoint or when a `key` resolver is configured, and `'raw'`
on a plain fire-and-forget endpoint. Set `forward: 'raw'` to pass the key on regardless.

An option present with the value `undefined` on an endpoint inherits the module default; it never
erases it.

### Caveats

- Guards, pipes and the handler body run **before** the claim and again on every repeat: validate
  there freely, but handler side effects are not deduplicated.
- `idempotency: false` turns off the inbound claim. On a fire-and-forget endpoint the header still
  travels in the message headers, so flows and activators still deduplicate on it; add
  `forward: 'none'` to switch that off too. On a `requestReply` endpoint it is not forwarded unless
  you ask for `forward: 'raw'` (a repeat dropped by the flow scope would end in a reply timeout).
  The raw request headers always reach your handler, whatever `forward` says.
- `{ useExisting }` resolves singleton providers only (no request or transient scope), once, on the
  first request of the endpoint. Misconfigurations surface as an `InboundError` on that request.
- GraphQL: the default header lookup does not see request headers. Set `clientKey` explicitly
  (for example `clientKey: 'idempotency-key'`) to enable inbound idempotency on a resolver.
- `InboundIdempotencyInFlightError` carries `code: 'IDEMPOTENCY_KEY_IN_PROGRESS'`; map it to HTTP 409
  or a gRPC status in your own exception filter.
- With the default envelope, a replayed request/reply answer carries fresh `id`/`traceId` values;
  use `'raw'` or a custom mapper when repeats must be byte-identical.
- The swagger DTOs (`InboundReplyDto`, …) describe the default envelope only.
- A custom store without the optional `release()` keeps working: `onFailure: 'release'` is rejected
  for it, and a classifier that answers `'release'` degrades to `keep` with one warning.

## Outbound REST: request/reply with your own contract

Since 0.8.0 a service can call other services **through estela** and get the HTTP response back as
the reply, with its own target, headers, idempotency key, timeout, retry policy and error contract.
Options go on each binding, or module-wide in `forRoot({ outbound: { rest: { defaults } } })`; a call
overrides the binding, which overrides the module default, which overrides the built-in. Every
strategy is a function, an instance, or a DI ref `{ useExisting: token }` (singletons).

**`bindRestOut` is unchanged**: it stays fire-and-forget (static url, JSON body, plain `Error` on a
non-2xx status, response body discarded, no timeout). The new API is opt-in.

Two ways in, same engine:

- **Channel binding**: a message sent to the channel is delivered as an HTTP call and the response
  is replied on `headers.replyChannel`, so `ReplyGateway.sendAndReceive(channel, …)`, a flow
  `jumpTo` and `to` all work. Without a reply channel the call is made and nothing is replied.
- **`OutboundRestGateway`**: an injectable port for code that has no channel (a saga `outbound`
  step, an activator): `await gateway.request(nameOrOptions, { payload, headers? }, call?)`.

```ts
IntegrationModule.forRoot({
  channels: [{ name: 'payments.http', type: 'direct' }],
  outbound: {
    rest: {
      defaults: { timeoutMs: 30_000, mapError: { useExisting: UpstreamErrors } },
      bindings: [
        // static target, reachable as a channel and by name
        { channel: 'payments.http', url: 'https://pay.example/charges',
          idempotency: { key: ({ payload }: OutboundCallContext<Charge>) => ['charge', payload.tenantId, payload.orderId] } },
        // dynamic target, no channel: only gateway.request('partner-api', …)
        { name: 'partner-api', target: { useExisting: PartnerTargets } },
      ],
    },
  },
});
```

The reply is `{ status, headers, body }` (`body` is parsed JSON, else the text, `null` when empty).
`response: 'body'` answers just the body; a mapper function, instance or DI ref answers whatever your
contract needs.

### Dynamic target, stable key, timeout and error mapping

```ts
@Injectable()
export class PartnerTargets {
  constructor(private readonly apis: ApiCatalog) {}

  // The annotated method IS the target resolver of the channel: (payload, message) => target.
  @OutboundRest({
    channel: 'partner.call',
    timeoutMs: 30_000,                                   // per attempt, enforced with AbortController
    idempotency: { header: 'X-Idempotency-Key' },        // the key itself comes from the target below
    mapHeaders: ({ message }) => ({                      // auth / propagated headers from the message
      authorization: message.headers.authorization as string | undefined,
      'x-client-id': message.headers.clientId as string | undefined,
    }),
    response: ({ response, target }) => (target.data as ApiRow).mapResponse(response.body),
    mapError: { useExisting: UpstreamErrors },
  })
  async target(cmd: CallApi): Promise<OutboundRestTarget> {
    const api = await this.apis.find(cmd.apiId);         // url, verb and headers come from data
    return {
      url: api.url,
      method: api.verb,                                  // GET, HEAD, DELETE, POST, PUT, PATCH, OPTIONS
      headers: api.headers,
      query: { tenant: cmd.tenantId },
      body: api.buildRequest(cmd.session),               // never sent for GET / HEAD
      idempotencyKey: [cmd.correlationId, cmd.apiId],    // STABLE: derived from business ids
      data: api,                                         // handed to the later strategies, never sent
    };
  }
}

@Injectable()
export class UpstreamErrors implements OutboundErrorMapper {
  mapError(error: OutboundRestError, ctx: OutboundExchangeContext) {
    return new BadRequestException({
      type: { http: 'HttpError', network: 'NetworkError', timeout: 'Timeout' }[error.kind],
      status: error instanceof OutboundHttpError ? error.status : 0,
      upstream: error instanceof OutboundHttpError ? error.body : error.message,
      url: error.url, method: error.method, responseTime: ctx.durationMs, attempts: error.attempts,
    });
  }
}
```

Inside a saga `outbound` step (no transaction is open while the call runs):

```ts
const complete = saga<CompleteCtx, EntityManager, CompleteReply>('complete')
  .transaction('claim', claimStep)
  .outbound('call-api', async (ctx) => {
    ctx.apiResult = await outbound.request(
      'partner.call',                                       // a declared binding, by name
      { payload: ctx.command, headers: { correlationId: ctx.correlationId, authorization: ctx.authorization } },
    );
  }, { compensate: releaseClaim })                          // runs when the call (or its mapper) throws
  .transaction('mark-completed', markCompleted)
  .reply((ctx) => ctx.response);
```

### Options

| Option | Default | Notes |
|---|---|---|
| `url` · `method` · `headers` · `query` | `method: 'POST'` | static part of the target; headers and query merge over the module defaults |
| `target` | — | per-message `{ url, method, headers, query, body, timeoutMs, idempotencyKey, data }`; each field overrides the static one |
| `mapHeaders` | — | hook `(ctx) => headers`; `undefined` values are skipped |
| `traceHeaders` | `true` | `x-trace-id`, `x-span-id`, `x-parent-span-id`, `x-correlation-id`, `x-causation-id` |
| `serializer` | `'json'` | `'text'`, `'form'` (`x-www-form-urlencoded`), or a function / instance / ref returning `{ body, contentType }` or a string |
| `response` | `'full'` | `'body'`, or a mapper receiving `{ response, request, payload, message, target, attempts, durationMs }` |
| `timeoutMs` | `30000` | per attempt; `0` disables; call > target > binding > module |
| `idempotency` | forward the message key | see below; `false` sends no key |
| `retry` | off | see below |
| `mapError` | — | receives `OutboundHttpError` / `OutboundNetworkError` / `OutboundTimeoutError`; what it returns is thrown |
| `fetchFn` | `globalThis.fetch` | injectable; no HTTP client dependency |

Header precedence, lowest first: serializer content type, static headers, trace headers, `target`
headers, `mapHeaders`, call headers, idempotency header. Names match case-insensitively, so your
`X-Correlation-ID` replaces the trace `x-correlation-id` instead of being sent twice.

**Idempotency key.** A key is **never generated**. By default the `idempotencyKey` header of the
message (the one an inbound adapter forwarded) is sent as `Idempotency-Key`. `header` renames it;
`key` resolves a stable key from the message (a string, or parts that are escaped and joined with
`:`) and turns forwarding off unless `forward: true`; `idempotencyKey` on the target or on the call
wins over the resolver; `idempotency: false` sends nothing.

**Retry.** Off unless `retry` is set. `{ maxAttempts = 3, backoff, retryOn, methods }`: a failure is
retried only when it is classified retryable (default: network errors, timeouts, HTTP 408, 429 and
5xx) **and** the method is safe to repeat: GET, HEAD or OPTIONS, any method while an idempotency key
is being sent, or a method listed in `methods`. The request is built once, so every attempt carries
the same key. `backoff` is a fixed delay, `{ initialMs = 200, factor = 2, maxMs = 10000 }` or a
function; the error mapper runs once, after the last attempt.

**Errors.** All three extend `OutboundRestError` (`kind`, `binding`, `url`, `method`, `attempts`):
`OutboundHttpError` adds `status`, `statusText`, `headers` and the parsed `body`;
`OutboundNetworkError` adds `code` (`ECONNREFUSED`, `ENOTFOUND`, …) and `cause`;
`OutboundTimeoutError` adds `timeoutMs`. Misconfigurations throw `OutboundError` when the binding is
declared (at boot), not on the first message.

**Observability.** One boot line per binding (`outbound rest: payments.http -> POST https://pay.example/charges`,
or `-> dynamic`), channel bindings recorded in the graph (`outbounds` on the node, an `outbound`
edge, a Mermaid line), and one hop line per call when `logging.hops` is on. Bodies, headers, key
values, query strings and url credentials are never logged; error messages carry the url without its
query string (`error.url` keeps the full one).

Caveats: strategies resolve singleton providers only; `{ useExisting }` and the configuration are
validated at boot for declared bindings and on the first call for ad-hoc options (keep those in a
constant so the plan is reused); a response mapper that throws is not passed to `mapError`; the
timeout applies to each attempt, not to the whole retry sequence; `Retry-After` is not honoured by
the default backoff (use a backoff function).

## Sagas: units of work and idempotency

A saga lists the steps of one business operation in order. Consecutive `transaction` steps share
one database transaction, so a failure rolls all of them back and a crashed pod leaves nothing half
written. An `outbound` step talks to the outside world and never runs inside a transaction: the unit
of work before it commits first, and its `compensate` undoes that work if the call fails. Steps share
state through a typed `ctx`.

```ts
const complete = saga<CompleteCtx, EntityManager, CompleteReply>('complete')
  .idempotent((ctx) => ctx.idempotencyKey)          // optional
  .transaction('claim', claimStep)                  // ─┐ one transaction
  .transaction('merge-session', mergeSession)       // ─┘
  .outbound('call-api', callApi, { compensate: releaseClaim })
  .transaction('mark-completed', markCompleted)     // second transaction
  .reply((ctx) => ctx.response);

const runner = new SagaRunner({ transactions: typeOrmPort, ledger: pgLedger, logger: new HopLogger() });
await runner.run(complete, ctx, { correlationId });
```

`transactions` adapts the app's client to `TransactionPort.run(work)`. With an `IdempotencyLedger`
the key is claimed inside the first unit of work and the reply is stored inside the last one, so the
ledger row commits together with the saga's writes, on every replica. A repeated key returns the
stored reply; one whose first run is still going raises `IdempotencyInProgressError`. A failed run
frees the key. `MemoryIdempotencyLedger` is for tests only: it is not atomic with any database, so
it declares `transactional = false`. For such a ledger the runner frees the claim itself when the
unit of work that took it rolls back (a thrown step or a failed COMMIT), so a client retry never
meets a stuck in-progress key or replays a reply whose writes never committed; the runner still
refuses it on an idempotent saga with a retry policy, because between `record` and a failing
COMMIT a concurrent duplicate can see an entry a transactional ledger would never have exposed.

### Locks

```ts
const start = saga<StartCtx, EntityManager, StartReply>('start')
  .lock('flow', (ctx) => ctx.flowId, 'shared')                               // Publish takes it 'exclusive'
  .lock('flow-start', (ctx) => `${ctx.flowId}:${ctx.userId}`, 'exclusive', { timeoutMs: 2_000 })
  .transaction('create-instance', createInstance)
  .reply((ctx) => ctx.reply);

const runner = new SagaRunner({
  transactions: { run: typeOrmRun, classify: classifyPostgresError },
  locks: postgresAdvisoryLockPort({ query: (m: EntityManager) => (s, p) => m.query(s, [...p]) }),
});
```

A lock binds **forward** to the next `transaction` step; all locks of a unit of work are taken once,
at its start, right after the idempotency claim, deduplicated (exclusive wins over shared) and in
one canonical order, so two sagas never deadlock on each other's locks. `mode` is required. A lock
not followed by a transaction step in the same unit (`.lock().outbound()`, a trailing `.lock()`) is
a `SagaDefinitionError`. Keys are computed from `ctx` as it is when the unit starts; `keyOf` may
return an array, and `undefined` is an error unless `{ optional: true }`. One unit may resolve at
most 64 locks after dedupe (`SagaRunnerOptions.maxLocksPerUnit`): each Postgres advisory lock takes
a slot in the server-wide shared lock table (`max_locks_per_transaction * max_connections`), so a
key list taken from user input could otherwise exhaust it for every session. Locks are
transaction-scoped (`pg_advisory_xact_lock`, never a session lock): they are taken inside the unit
of work's transaction, right after the claim, so the lock, a CAS `transition()` and the step
writes share one transaction, COMMIT or ROLLBACK is the only release (nothing to forget in a
`finally`, nothing stranded on a pooled connection), and they never span an outbound step. That
only holds inside a transaction block, so `postgresAdvisoryLockPort` throws `SagaUsageError` when
`TransactionPort.run` hands it a connection in autocommit mode (no `BEGIN`): a lock released as
soon as it is granted protects nothing. A failed outbound's `compensate` re-acquires the same
locks (`compensateLocks: 'none'` opts out).
`postgresAdvisoryLockPort` maps `(namespace, key)` to one int8: the first 64 bits of SHA-256 over
a length-prefixed encoding, so a key built partly from user input (a username) cannot be crafted to
collide with someone else's lock (a 32-bit `hashtext` could be brute-forced offline). Code outside
Estela that must take the same lock binds `[namespace, key]` to `ADVISORY_LOCK_KEY_SQL`. Postgres
11+.

**Isolation level.** A lock protects what a step *reads* only under READ COMMITTED, where every
statement takes a fresh snapshot after the lock is granted. Under REPEATABLE READ the snapshot is
taken by the first statement of the transaction, before the lock wait, so a read-then-insert
check still sees pre-wait data: `postgresAdvisoryLockPort` throws `SagaUsageError` there unless
`allowSnapshotIsolation: true` (for steps that never read what the lock protects). Under
SERIALIZABLE the same race surfaces as `40001`: add `'serialization'` to `retry.on`.

### Retry

```ts
.retry({ on: ['deadlock', 'lock-timeout', 'serialization'], attempts: 3, backoffMs: 20 })
```

Only a failed unit of work is re-run; it is atomic, so that is safe. Committed units and outbound
steps are never re-run. `attempts` counts every attempt including the first (1..20); the backoff is
exponential (`maxBackoffMs` defaults to `backoffMs * 32`) with `'full'` jitter by default. Before
each unit the runner snapshots `ctx` with `structuredClone` and restores it in place before a
retry; a ctx holding class instances or functions, symbol-keyed or non-enumerable properties, or a
frozen root with mutable children cannot be snapshotted that way (`SagaUsageError`), so pass
`checkpoint: (ctx) => restoreThunk` instead. Do the same for a class-instance ctx that keeps state
in `#private` fields: the clone cannot see them. A failing checkpoint fails the run (before any
transaction) only for the first unit; a later unit (after a commit or an outbound call, including a
compensation and the ledger record) still runs, once and without retry, and the failure is logged
at error level. The policy is re-validated by `run()`, so a hand-built `SagaDefinition` gets the
same bounds as `.retry()`. The idempotency claim is redone on every attempt. A
`TransactionPort` that re-runs `work` itself (its own retry on 40001) is handled the same way: each
call gets a fresh claim, fresh in-process locks and no callbacks from the rolled-back call, and
ctx is restored when the saga has a retry policy. A
classifier is required for database kinds (`TransactionPort.classify` or `classifyError`), so the
error identity only changes when you opt in: exhausted or unlisted kinds throw `LockTimeoutError`,
`DeadlockError` or `SerializationError` (all `ConcurrencyError`, with `cause`, `saga`, `unit`,
`attempts`). Their message holds only the kind, saga, unit and attempts; the driver error (table
and constraint names) stays in `cause`, so do not send `cause` to clients. A classifier result
other than `'lock-timeout'`, `'deadlock'` or `'serialization'` (a typo, `'stale-state'`) counts as
unclassified: the original error is rethrown. `IdempotencyInProgressError`,
`IllegalTransitionError`, `TransitionOutcomeUnknownError` and `SagaUsageError` are never retried or
wrapped, whatever the classifier says. Map them to 503 + `Retry-After`, and `StaleStateError` to
409.

### afterCommit

Transaction steps receive a third argument: `(ctx, tx, unit) => unit.afterCommit(() => cache.del(key))`.
A 2-argument step is still accepted, but `unit` is required on the call side of
`TransactionStep`: code that calls a stored step or `options.compensate` itself must forward
`unit` (`(ctx, tx, unit) => inner(ctx, tx, unit)`), and a wrapper that drops it is a compile error
instead of an `undefined` dereference at run time. In unit tests, pass `testUnitOfWork()` from
`@estela/nest/testing` and call `unit.commit()` to run the callbacks.
Callbacks run in registration order only after that unit of work commits, before the next step and
before `run()` resolves; callbacks of a rolled-back or retried attempt are discarded. A failing
callback cannot un-commit: it is logged at error level (`HopLogger.hopError`, or a Nest `Logger`)
and passed to `onAfterCommitError`, and the saga still succeeds. It is not durable (use an outbox
for effects that must happen) and it does not close reader/cache races on its own: use versioned
cache keys or a TTL.

### State machine with `transition()`

```ts
const Instance = defineStateMachine('instance', {
  PENDING: ['RUNNING', 'CANCELLED'], RUNNING: ['DONE', 'FAILED'], DONE: [], FAILED: [], CANCELLED: [],
});
const instances = postgresTransitionPort({ query: (m: EntityManager) => (s, p) => m.query(s, [...p]),
  table: 'instances', stateColumn: 'status', versionColumn: 'version' });

.transaction('start', async (ctx, tx) => {
  await transition(Instance, instances, tx, { id: ctx.id, to: 'RUNNING' });
})
```

`transition` throws `IllegalTransitionError` before touching the database, then runs one
`UPDATE ... WHERE id = $2 AND state = ANY($3) [AND version = $4]` (version bumped) and requires
`affected === 1`. `0` is `StaleStateError`: the row moved under you, never a silent success.
Anything that is not an exact integer 0 or 1 (`undefined`, `null`, `"1"`, `2`) is
`TransitionOutcomeUnknownError`: adapt the driver result in your query function. States are typed
from the machine only, so a misspelled `to` or `from` is a compile error. A `versionColumn` may be
int4 or int8 (string from pg, `bigint` from Prisma); a version that is not a safe integer throws
rather than being dropped. The Postgres
adapters need no `pg` dependency: they take `query: (tx) => (sql, params) => Promise<rows | { rows }>`
(pg: `(c) => (s, p) => c.query(s, [...p])`; Prisma: `(tx) => (s, p) => tx.$queryRawUnsafe(s, ...p)`).
Identifiers are validated and quoted, values are always bound, locks use
`pg_advisory_xact_lock[_shared](int8)` (see Locks) with a parameterized local
`lock_timeout`, and `classifyPostgresError` maps SQLSTATE `55P03` / `40P01` / `40001` (pg `code`,
TypeORM `driverError.code`, Prisma raw-query `meta.code`). Prisma's ORM-level `P2034` ("write
conflict or a deadlock") has no SQLSTATE and is mapped to `deadlock`; with Prisma list both
`'deadlock'` and `'serialization'` in `retry.on`. Prisma also binds a JS string as `text` (pg and
TypeORM leave parameters untyped for Postgres to infer), so with Prisma a non-text id or state
column needs its type: `idType: 'uuid'`, `stateType: 'app.status_enum'` (validated, quoted, bound as
`$n::text::type`).

Rules of thumb: a lock protects a unit of work, a state machine protects a saga (move to a PENDING
state with CAS before an outbound call); transaction steps only touch the database, because a retry
re-runs them; never swallow a database error inside a step (Postgres turns the COMMIT into a silent
ROLLBACK); `TransactionPort.run` must open a new top-level transaction, never join an ambient one.

## Observability

```bash
curl localhost:3000/integration/graph          # nodes · edges · flows (JSON)
curl localhost:3000/integration/graph/mermaid  # topology as Mermaid
```

```mermaid
flowchart LR
  orders_place["direct: orders.place"] -->|wireTap| orders_audit["queue: orders.audit"]
  orders_place -->|jump · place-order| inventory_reserve["direct: inventory.reserve"]
  orders_place -->|publish · rk:order.placed| domain_events["pubsub: domain.events"]
  inventory_reserve --> act["activator: InventoryActivator.reserve"]
```

On startup the first `IntegrationModule` prints this banner once per process:

```
 ______  _____ _______ ______ _
|  ____|/ ____|__   __|  ____| |        /\
| |__  | (___    | |  | |__  | |       /  \
|  __|  \___ \   | |  |  __| | |      / /\ \
| |____ ____) |  | |  | |____| |____ / ____ \
|______|_____/   |_|  |______|______/_/    \_\

  ESTELA - created by: www.dyddtech.com
  Enterprise Integration Patterns for NestJS
```

Turn it off with `forRoot({ logging: { banner: false } })` or `ESTELA_BANNER=false`. Per-hop
logging is separate and opt-in: `forRoot({ logging: { hops: true } })`.

The boot log also lists every wired entry and exit point, one line per activator, per annotated
inbound endpoint (`@InboundRest` / `@InboundGrpc` / `@InboundGraphQL`) and per declared outbound
REST binding; inbounds and channel-bound outbounds are recorded in the graph:

```
activator: InventoryActivator.reserve -> inventory.reserve
inbound rest: POST /V1/Workflows/:id/Start -> wf.start (request-reply)
inbound grpc: WorkflowLifecycleService/Start -> wf.start (request-reply)
inbound graphql: mutation placeOrder -> orders.place
outbound rest: payments.http -> POST https://pay.example/charges
outbound rest: partner.call -> dynamic
```

Only transport, route or pattern, channel and the request-reply flag are printed. When route
metadata is not readable the line falls back to `Class.method`. The missing `AMQP_CHANNEL`
warning is emitted only when `rabbitMappings` are declared without a `rabbitChannel`.

## Architecture

Hexagonal (ports & adapters) with explicit SOLID + GoF:
`FlowStep` = **Command** · `FlowExecutor` = **Template Method** · `IntegrationFlow` = **Builder** ·
`FanoutChannel` = **Composite** · `ChannelRegistry` = **Mediator** · channels/stores = **Strategy** ·
`nextHop` = **Prototype** · `NoopIdempotencyStore` = **Null Object** · ephemeral channels = **Proxy**.

```text
interface (decorators · interceptor · controller · module · testing)
        ↓
application (flow-executor · activator-wrapper · registry · gateway · graph)
        ↓
domain (message · channel · flow-step)          ← zero dependencies, enforced
        ↳ infrastructure: in-memory channels · memory store · rest/grpc/rabbit adapters
```

Event-driven engine, 100% native Node ≥ 18: `node:events` · `AsyncLocalStorage` +
`AsyncResource.bind` · `AbortSignal.timeout` · `Promise.all/allSettled` · `setImmediate` ·
`OnApplicationShutdown` (queue drain).

## Agent skills

ESTELA ships portable **agent skills** (SKILL.md) so Claude Code, Codex, Cursor and any
SKILL.md-compatible agent adopt it as the messaging standard:

| Skill | Use when… |
|---|---|
| [`estela-setup`](./skills/estela-setup/SKILL.md) | wiring `IntegrationModule.forRoot` into a Nest app |
| [`estela-flows`](./skills/estela-flows/SKILL.md) | authoring channels/flows/activators |
| [`estela-testing`](./skills/estela-testing/SKILL.md) | writing deterministic tests |
| [`estela-review`](./skills/estela-review/SKILL.md) | reviewing PRs against the invariants |

Install: copy a folder into `~/.codex/skills/`, `~/.claude/skills/` or `.agents/skills/` —
details in [`skills/README.md`](./skills/README.md). Repo-root agent rules: [`AGENTS.md`](./AGENTS.md).

## Testing

```ts
import { bindFlow, createTestMessage, waitFor, MemoryIdempotencyStore } from '@estela/nest/testing';

bindFlow(PlaceOrderFlow, registry, { idempotency: new IdempotencyService({ store: new MemoryIdempotencyStore() }) });
await registry.send('orders.place', { qty: 2, sku: 'A' });
const reply = await waitFor(registry, 'reply.http-1', 2_000);
```

Saga helpers: `MemoryLockPort` (in-process, NOT cross-process), `MemoryTransitionPort`, and
`testUnitOfWork()` to call a transaction step directly. The published type declarations stay
parseable by TypeScript 4.9 (no TS 5-only syntax such as `const` type parameters; checked by
`test/dist-typescript4.spec.ts`).

## Status

| | |
|---|---|
| Tests | **421/421** · 31 suites · real HTTP e2e |
| Spec | 10/10 minimal tests · DoD §15 complete |
| Boundaries | pure domain · broker-free barrel · testing w/o inbound (0 violations) |
| Build | ESM + CJS + d.ts · Node ≥ 18 |

Runnable example: [`src/example/`](./src/example) · `npm run verify` = typecheck → **eslint (type-checked + sonarjs + security)** → prettier → build → jest → bounds → **madge + jscpd** → **npm audit + lockfile-lint**.

---

<div align="center">

<sub>**ESTELA** — built with ☄️ by [**DYDD Technologies**](https://www.dyddtech.com) · created & maintained by [**Eliu Diaz**](https://www.linkedin.com/in/eliudiaz) · sole maintainer [@eliudiaz-dydd](https://github.com/eliudiaz-dydd)</sub>

</div>

## License

MIT
