<div align="center">
  <img src="assets/estela-banner.svg" alt="ESTELA — EIP runtime para NestJS" width="100%" />

  **El runtime de Enterprise Integration Patterns para NestJS.**
  *El flow habla con canales, no con clases.*

  [![tests](https://img.shields.io/badge/tests-421%2F421-brightgreen)](#estado)
  [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](#arquitectura)
  [![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](#instalaci%C3%B3n)
  [![NestJS](https://img.shields.io/badge/NestJS-10%20%7C%2011-E0234E?logo=nestjs&logoColor=white)](#instalaci%C3%B3n)
  [![license](https://img.shields.io/badge/license-MIT-blue)](#licencia)
  [![website](https://img.shields.io/badge/DYDD_Technologies-dyddtech.com-0A66C2)](https://www.dyddtech.com)
  [![LinkedIn](https://img.shields.io/badge/LinkedIn-eliudiaz-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/eliudiaz)
  [![maintainer](https://img.shields.io/badge/maintainer-eliudiaz--dydd-181717?logo=github)](https://github.com/eliudiaz-dydd)

  [English](./README.md) · **Español** · [Português](./README.pt.md) · [Français](./README.fr.md)

  [Instalación](#instalación) · [Quick start](#quick-start) · [Canales](#canales) · [DSL](#dsl-de-flows) · [Trazas](#trazas-e-idempotencia) · [Adaptadores inbound](#adaptadores-inbound-respuesta-e-idempotencia-a-medida) · [Observabilidad](#observabilidad) · [Arquitectura](#arquitectura)
</div>

---

## Por qué ESTELA

**Estela**: el rastro que deja un cometa. Cada mensaje que viaja por el runtime deja
huella — `traceId`, `spanId`, `history` de hops — y cada hop es un punto en la estela.
Semántica de Spring Integration, nativa de Node:

- **4 canales in-memory** con semántica EIP real: `direct` · `queue` · `pubsub` · `fanout`.
- **DSL de flows fluido** con 10 patrones: `filter → transform → wireTap → fanoutTo → jumpTo → publish → route → to → reply`.
- **Request/reply** con canales efímeros y timeouts race-free (`AbortSignal.timeout`).
- **Trazas** con `AsyncLocalStorage` + reconstrucción de contexto desde headers en cada hop.
- **Idempotencia** con scopes `flow:*` / `activator:*` y store intercambiable (memoria o Redis).
- **Inbound REST / gRPC / Rabbit / GraphQL** declarado en controllers, jamás en `forRoot`.
- **Grafo vivo** de tu topología: JSON + Mermaid en dos endpoints.
- **100% nativo**: mensajería sin brokers ni dependencias de runtime. Los brokers son puertos.

```mermaid
flowchart LR
  subgraph ESTELA
    direction LR
    IN["@InboundRest / gRPC / GraphQL / Rabbit"] --> C["Canales\ndirect · queue · pubsub · fanout"]
    C --> F["FlowEngine\nfilter · transform · fanout · jump · reply"]
    F --> A["@ServiceActivator\ntu clase, enganchada"]
    A --> OUT["Outbound\nREST · gRPC · Rabbit"]
    F -.trace + idempotencia.-> C
  end
```

## Instalación

```bash
npm install https://github.com/dyddtechnologies/estela/releases/download/v0.1.0/estela-nest-0.1.0.tgz
```

> Distribuido como **artifact de GitHub Releases** (tarball) — sin registro npm.
> Peers: `@nestjs/common/core` ^10‖^11 · `@nestjs/swagger` ^7‖^8 · `reflect-metadata` · `rxjs`.
> Opcionales (solo tipos/adapters, **jamás** en el barrel): `amqplib` · `@grpc/grpc-js` · `@nestjs/graphql`.

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
      .wireTap('orders.audit')                                      // fire-and-forget, jamás falla
      .jumpTo([{ channel: 'inventory.reserve', timeoutMs: 3_000 }]) // wait → jumpReplies
      .publish('domain.events', 'order.placed')
      .reply()                                                      // cierra el HTTP si hay replyChannel
      .to('orders.persist'),
};
```

```ts
@Injectable()
export class InventoryActivator {
  @ServiceActivator('inventory.reserve')
  reserve(payload: unknown): string {
    return 'reserved'; // el wrapper responde al replyChannel del hop (jump incluido)
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

## Canales

| Kind | Semántica |
|---|---|
| `direct` | 1 subscriber · `send` espera el handler · sin subscriber → throw |
| `queue` | buffer FIFO + round-robin · capacity · overflow → error (nunca drop silencioso) |
| `pubsub` | broadcast · glob `*`/`#` en routingKey · grupos round-robin · fallo aislado por subscriber |
| `fanout` | Composite: copia a bindings + subscribers · awaited o forget · **cycle guard A↔B** |

## DSL de flows

| Step | Semántica |
|---|---|
| `filter` | descarta con éxito (idempotencia `{filtered:true}`) |
| `transform` / `handle` | cambian el payload; `handle` no dispara reply |
| `wireTap` | copia sin bloquear; ignora errores (§17.6) |
| `fanoutTo` | grupo awaited en paralelo; `wait:false` → forget a `error.channel` |
| `jumpTo` / `jump` | canal efímero propio · await reply + timeout · `jumpReplies[channel]` |
| `publish` | `nextHop` + routingKey · no corta |
| `route` | dinámico `string \| string[]` · termina |
| `to` | envía y **termina** |
| `reply({payload})` | `'current'` \| `'jumpMerge'` → responde al `replyChannel` |

**Precedencia `replyChannel`** (invariante del runtime): `wireTap/fanout/publish → none` ·
`to/route → inherit` · `jump → efímero propio`. El padre siempre conserva el reply del inbound.

## Trazas e idempotencia

| Header | Mensaje |
|---|---|
| `x-trace-id` / `x-span-id` / `x-parent-span-id` | `traceId` · `spanId` · `parentSpanId` |
| `x-correlation-id` / `x-causation-id` | `correlationId` · `causationId` |
| `idempotency-key` / `x-idempotency-key` | `idempotencyKey` |

Scopes: `flow:${name}` · `activator:${Class}.${method}` · storage key `${scope}::${key}` ·
sin key → no-op · `enabled:false` → Null Object.

<details>
<summary><strong>Implementar <code>IdempotencyStore</code> con Redis (contrato only)</strong></summary>

```ts
export class RedisIdempotencyStore implements IdempotencyStore {
  private k = (scope: string, key: string) => `${scope}::${key}`;
  async begin(scope: string, key: string, ttlMs: number) {
    return (await this.redis.set(this.k(scope, key), 'in-flight', 'PX', ttlMs, 'NX')) === 'OK';
  }
  async complete(scope: string, key: string, result: Record<string, unknown>) {
    await this.redis.set(this.k(scope, key), JSON.stringify({ status: 'completed', result }), 'KEEPTTL');
  }
  async fail(scope: string, key: string, error: unknown) { /* KEEPTTL + status failed */ }
  async get(scope: string, key: string) { /* JSON → IdempotencyRecord | undefined */ }
  async purgeExpired() { return 0; } // TTL nativo de Redis
  // Opcional (0.6.0): permite que `onFailure: 'release'` del inbound libere la key y el reintento corra
  async release(scope: string, key: string) { await this.redis.del(this.k(scope, key)); }
}

forRoot({ channels, idempotency: { store: new RedisIdempotencyStore(redis) } });
```
</details>

## Adaptadores inbound: respuesta e idempotencia a medida

`@InboundRest`, `@InboundGrpc` y `@InboundGraphQL` lanzan un flujo desde un handler anotado. Desde
la 0.6.0 cada endpoint puede responder con **su propio contrato** y aplicar **sus propias reglas de
idempotencia**. Las opciones van en el decorador o, para todo el módulo, en `forRoot({ inbound })`;
el endpoint gana sobre el default del módulo y este sobre el de fábrica.

**Sin configurar nada, nada cambia**: el endpoint responde el envelope de estela
(`{status:'ok'|'accepted'|'duplicate', …}`) y deduplica por `idempotency-key` en el scope
`inbound:<channel>`, igual que en la 0.5.0.

### Mapeo de la respuesta

```ts
@InboundRest({ channel: 'orders.place', requestReply: true, reply: 'raw' })   // sólo el resultado del flujo

@InboundRest({
  channel: 'wf.start', requestReply: true,
  reply: ({ result, payload, receivedAt }: InboundReplyContext<StartPayload, StartResult>) => ({
    data: { ...result, correlationId: payload.correlationId, responseTime: Date.now() - receivedAt },
    success: true,
  }),
})

// gRPC: responder la forma del mensaje proto
@InboundGrpc({
  channel: 'wf.complete', requestReply: true,
  reply: ({ result, payload }: InboundReplyContext<CompleteInput, CompleteResult>) => ({
    instanceId: result.instanceId ?? payload.instanceId,
    resultJson: JSON.stringify(result),
  }),
})

// Un provider que inyecta servicios: se pasa una referencia, nunca la clase suelta
@InboundRest({ channel: 'orders.place', requestReply: true, reply: { useExisting: OrderReplyMapper } })

IntegrationModule.forRoot({ channels, inbound: { reply: 'raw' } }, flows);     // default del módulo
```

| `reply` | request/reply | fire-and-forget (accepted) | key repetida (duplicate) |
|---|---|---|---|
| `'envelope'` (default) | `{status:'ok', result, …}` | `{status:'accepted', …}` | `{status:'duplicate', …}` |
| `'raw'` | el resultado del flujo | lo que devuelve el handler | `{status:'duplicate', …}` |
| función · `{ mapReply }` · `{ useExisting }` | tu forma | tu forma | tu forma |

Un mapper propio recibe un `InboundReplyContext`: `kind` (`'reply' \| 'accepted' \| 'duplicate'`),
`result`, `payload`, `rawHeaders`, `handlerResult`, el `context` de Nest, `receivedAt`, `replayed`,
`duplicateOf`, `acceptedId`, el `message` y el `envelope` que estela habría respondido. Puede ser
async. Corre después de escribir el registro de idempotencia, así que un mapper que lanza nunca
libera ni marca como fallida la key.

### Opciones de idempotencia

```ts
@InboundRest({ channel, idempotency: false })            // sin claim inbound en este endpoint
@InboundRest({ channel, idempotency: { /* opciones */ } })
IntegrationModule.forRoot({ channels, inbound: { idempotency: { /* opciones */ } } }, flows);
```

| Opción | Default | Significado |
|---|---|---|
| `enabled` | `true` | `false` omite el claim. **No se hereda**: un endpoint que pasa un objeto de opciones queda habilitado salvo que diga lo contrario, aunque el default del módulo sea `false`. |
| `clientKey` | `idempotency-key`, `x-idempotency-key` | De dónde sale la key del cliente: un header, una lista de headers (sin distinguir mayúsculas) o `(ctx) => string \| undefined`. |
| `key` | la key del cliente | Resolver de la key de almacenamiento: función, `{ resolveKey }` o `{ useExisting }`. Recibe `payload`, `rawHeaders`, `context`, `clientKey`. Devuelve un string (se usa tal cual), un array de partes (se escapan y se unen con `:`), `{ scope, key }`, o `undefined`/`null` para omitir el claim. Puede ser async. **Puede lanzar**: el request se rechaza y no se reclama nada. Se llama aunque el cliente no envíe key, así que valida `clientKey`: una key vacía o una parte que no sea un string no vacío o un número finito (`undefined`, `null`, `''`) se rechaza con `InboundError` en vez de fusionar llamadores en una sola key. |
| `scope` | `inbound:<channel>` | Scope de almacenamiento (storage key = `${scope}::${key}`). |
| `ttlMs` | `idempotency.ttlMs` del módulo, si no 1 h | TTL que recibe `store.begin`. |
| `store` | el `IdempotencyService` del módulo | Una instancia de `IdempotencyStore` o `{ useExisting }`. |
| `onDuplicate` | `'envelope'` | `'replay'` responde un repetido completado **por el mismo mapper** que la primera vez. |
| `onInFlight` | `'duplicate'` | `'reject'` lanza `InboundIdempotencyInFlightError`; una función devuelve el error a lanzar. |
| `onFailure` | `'keep'` | `'release'`, `'store'`, `'marker'`, o un clasificador `(error, ctx) => 'keep' \| 'release' \| 'store'` (función, `{ classify }`, `{ useExisting }`). |
| `failureCodec` | `HttpExceptionFailureCodec` | `{ serialize, deserialize }` para los fallos almacenados. |
| `forward` | ver [Propagación](#propagación-de-la-key-aguas-abajo) | `'raw' \| 'resolved' \| 'none'`. |

**Una key repetida** (`store.begin` devolvió `false`):

| Registro almacenado | `onDuplicate: 'envelope'` | `onDuplicate: 'replay'` |
|---|---|---|
| request/reply completado | duplicate (`result` = resultado cacheado) | se mapea como `kind:'reply'`, `replayed:true` |
| fire-and-forget completado | duplicate (`result: null`) | se mapea como `kind:'accepted'` con el id almacenado |
| fallo almacenado | relanza el error almacenado | relanza el error almacenado |
| fallido y retenido | duplicate (`duplicateOf:'failed'`, `result: null`) | igual |
| todavía en vuelo | `onInFlight` | `onInFlight` |

**Un despacho fallido** (la primera ejecución siempre relanza el mismo error, sin tocarlo):

| Acción | Llamada al store | Siguiente request con la misma key |
|---|---|---|
| `keep` | `fail()` | se responde como duplicate hasta que expire el TTL |
| `release` | `release()` | se ejecuta de verdad |
| `store` | `complete()` con el fallo serializado | relanza el fallo deserializado |

Cómo se elige la acción: `'keep'` (default) ignora todo. Cualquier otro `onFailure` respeta primero
la marca puesta en el error con `markInboundFailure(error, action)`; sin marca, `'marker'` retiene,
`'release'`/`'store'` se aplican (salvo a un `ReplyTimeoutError` o un `NoSubscriberError`, que se
retienen porque el flujo puede seguir corriendo o haber terminado sin ser respondido) y un
clasificador decide. Un flujo sobre canales esperados que excede `timeoutMs` aparece como
`ReplyTimeoutError`. El codec por defecto conserva status y body de un
`HttpException` de Nest; cualquier otro error se reproduce como `InboundReplayedFailureError`, que
Nest responde como 500. No se guarda el stack.

### Ejemplo multi-tenant

```ts
@Injectable()
export class TenantKeyResolver implements InboundKeyResolver<CompletePayload> {
  constructor(private readonly steps: StepGuard) {}

  async resolveKey({ payload, clientKey }: InboundKeyContext<CompletePayload>) {
    await this.steps.assertCompletable(payload);      // un request rechazado nunca reclama key
    if (clientKey === undefined) return undefined;    // sin key: sin idempotencia
    return {
      scope: 'wf-complete',
      key: [payload.tenantId, payload.flowId, payload.stepId, clientKey],   // atada al tenant
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
    store: { useExisting: PgIdempotencyStore },       // tu propio provider de IdempotencyStore
    onDuplicate: 'replay',                            // el repetido recibe la primera respuesta
    onInFlight: () => new ConflictException('IDEMPOTENCY_KEY_IN_PROGRESS'),   // HTTP 409
    onFailure: 'marker',                              // decide el código de negocio, por error
  },
})
complete(@Param() params: CompleteParams, @Tenant() tenantId: string, @Body() body: CompleteBody) {
  return { ...params, tenantId, ...body };            // lo que devuelve es el payload del flujo
}

// Donde ocurre el trabajo (activator, saga…): decir qué implica el fallo para la key
throw markInboundFailure(error, committedLevels === 0 ? 'release' : 'store');
```

Dos tenants que envían el mismo `Idempotency-Key` tienen ahora dos keys de almacenamiento distintas,
así que ninguno puede recibir la respuesta cacheada del otro. Un error de validación libera la key y
el reintento se ejecuta; un fallo con trabajo parcialmente confirmado se almacena y cada reintento
recibe el mismo error HTTP.

### Propagación de la key aguas abajo

El `headers.idempotencyKey` del mensaje despachado es lo que deduplican los scopes `flow:<name>` y
`activator:<Class>.<method>`.

| `forward` | Los scopes de flujo y activator ven |
|---|---|
| `'raw'` | la key del cliente |
| `'resolved'` | la key de almacenamiento codificada (atada al tenant si tu resolver lo está) |
| `'none'` | nada |

El default es `'raw'`. Pasa a `'none'` en cuanto se configura `key` o un `onFailure` distinto de
`'keep'`: una key cruda aguas abajo permitiría que dos tenants se bloqueen en el scope del flujo, y
una key liberada en el scope inbound pero aún reclamada por el flujo convertiría el reintento en un
duplicate silencioso del flujo (un `ReplyTimeoutError`). Por eso se rechaza combinar un `onFailure`
con `'raw'` o `'resolved'` explícitos.

Con el claim apagado (`idempotency: false`) nada responde una repetición en el scope inbound, así que
el default es `'none'` en un endpoint `requestReply` o cuando hay un resolver `key` configurado, y
`'raw'` en un endpoint fire-and-forget simple. Usa `forward: 'raw'` para propagar la key igualmente.

Una opción presente con valor `undefined` en un endpoint hereda el default del módulo; nunca lo
borra.

### Advertencias

- Guards, pipes y el cuerpo del handler corren **antes** del claim y otra vez en cada repetido:
  validar ahí es seguro, pero los efectos secundarios del handler no se deduplican.
- `idempotency: false` apaga el claim inbound. En un endpoint fire-and-forget el header sigue
  viajando en los headers del mensaje, así que flujos y activators siguen deduplicando por él; agrega
  `forward: 'none'` para apagar eso también. En un endpoint `requestReply` no se propaga salvo que
  pidas `forward: 'raw'` (una repetición descartada por el scope del flujo terminaría en un timeout
  de reply). Los headers crudos del request siempre llegan a tu handler, diga lo que diga `forward`.
- `{ useExisting }` resuelve sólo providers singleton (no request ni transient), una vez, en el
  primer request del endpoint. Una mala configuración aparece como `InboundError` en ese request.
- GraphQL: la búsqueda de headers por defecto no ve los headers del request. Define `clientKey`
  (por ejemplo `clientKey: 'idempotency-key'`) para tener idempotencia inbound en un resolver.
- `InboundIdempotencyInFlightError` trae `code: 'IDEMPOTENCY_KEY_IN_PROGRESS'`; mapéalo a HTTP 409
  o a un status gRPC en tu propio exception filter.
- Con el envelope por defecto, un request/reply reproducido trae `id`/`traceId` nuevos; usa `'raw'`
  o un mapper propio cuando los repetidos deban ser idénticos byte a byte.
- Los DTOs de swagger (`InboundReplyDto`, …) describen sólo el envelope por defecto.
- Un store propio sin el `release()` opcional sigue funcionando: `onFailure: 'release'` se rechaza
  para él, y un clasificador que responde `'release'` degrada a `keep` con un único warning.

## Outbound REST: request/reply con tu propio contrato

Desde la 0.8.0 un servicio puede llamar a otros servicios **a través de estela** y recibir la
respuesta HTTP como reply, con su propio destino, headers, idempotency key, timeout, política de
reintentos y contrato de error. Las opciones van en cada binding o, para todo el módulo, en
`forRoot({ outbound: { rest: { defaults } } })`; la llamada gana sobre el binding, este sobre el
default del módulo y este sobre el de fábrica. Cada estrategia es una función, una instancia o una
referencia DI `{ useExisting: token }` (singletons).

**`bindRestOut` no cambia**: sigue siendo fire-and-forget (url estática, body JSON, `Error` plano
ante un status no 2xx, body de la respuesta descartado, sin timeout). La API nueva es opt-in.

Dos entradas, un mismo motor:

- **Binding de canal**: un mensaje enviado al canal se entrega como llamada HTTP y la respuesta se
  contesta en `headers.replyChannel`, así que `ReplyGateway.sendAndReceive(canal, …)`, un `jumpTo`
  de flow y `to` funcionan. Sin reply channel la llamada se hace y no se contesta nada.
- **`OutboundRestGateway`**: un puerto inyectable para código que no tiene canal (un paso `outbound`
  de saga, un activator): `await gateway.request(nombreUOpciones, { payload, headers? }, call?)`.

```ts
IntegrationModule.forRoot({
  channels: [{ name: 'payments.http', type: 'direct' }],
  outbound: {
    rest: {
      defaults: { timeoutMs: 30_000, mapError: { useExisting: UpstreamErrors } },
      bindings: [
        // destino estático, alcanzable como canal y por nombre
        { channel: 'payments.http', url: 'https://pay.example/charges',
          idempotency: { key: ({ payload }: OutboundCallContext<Charge>) => ['charge', payload.tenantId, payload.orderId] } },
        // destino dinámico, sin canal: solo gateway.request('partner-api', …)
        { name: 'partner-api', target: { useExisting: PartnerTargets } },
      ],
    },
  },
});
```

El reply es `{ status, headers, body }` (`body` es el JSON parseado, si no el texto, `null` si viene
vacío). `response: 'body'` responde solo el body; un mapper (función, instancia o ref DI) responde lo
que tu contrato necesite.

### Destino dinámico, key estable, timeout y mapeo de errores

```ts
@Injectable()
export class PartnerTargets {
  constructor(private readonly apis: ApiCatalog) {}

  // El método anotado ES el target resolver del canal: (payload, message) => target.
  @OutboundRest({
    channel: 'partner.call',
    timeoutMs: 30_000,                                   // por intento, con AbortController
    idempotency: { header: 'X-Idempotency-Key' },        // la key la define el target de abajo
    mapHeaders: ({ message }) => ({                      // auth / headers propagados desde el mensaje
      authorization: message.headers.authorization as string | undefined,
      'x-client-id': message.headers.clientId as string | undefined,
    }),
    response: ({ response, target }) => (target.data as ApiRow).mapResponse(response.body),
    mapError: { useExisting: UpstreamErrors },
  })
  async target(cmd: CallApi): Promise<OutboundRestTarget> {
    const api = await this.apis.find(cmd.apiId);         // url, verbo y headers salen de datos
    return {
      url: api.url,
      method: api.verb,                                  // GET, HEAD, DELETE, POST, PUT, PATCH, OPTIONS
      headers: api.headers,
      query: { tenant: cmd.tenantId },
      body: api.buildRequest(cmd.session),               // nunca se envía en GET / HEAD
      idempotencyKey: [cmd.correlationId, cmd.apiId],    // ESTABLE: derivada de ids de negocio
      data: api,                                         // llega a las estrategias siguientes; no se envía
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

Dentro de un paso `outbound` de saga (no hay transacción abierta mientras corre la llamada):

```ts
const complete = saga<CompleteCtx, EntityManager, CompleteReply>('complete')
  .transaction('claim', claimStep)
  .outbound('call-api', async (ctx) => {
    ctx.apiResult = await outbound.request(
      'partner.call',                                       // un binding declarado, por nombre
      { payload: ctx.command, headers: { correlationId: ctx.correlationId, authorization: ctx.authorization } },
    );
  }, { compensate: releaseClaim })                          // corre si la llamada (o su mapper) lanza
  .transaction('mark-completed', markCompleted)
  .reply((ctx) => ctx.response);
```

### Opciones

| Opción | Default | Notas |
|---|---|---|
| `url` · `method` · `headers` · `query` | `method: 'POST'` | parte estática del destino; headers y query se fusionan sobre los defaults del módulo |
| `target` | — | por mensaje: `{ url, method, headers, query, body, timeoutMs, idempotencyKey, data }`; cada campo pisa al estático |
| `mapHeaders` | — | hook `(ctx) => headers`; los valores `undefined` se omiten |
| `traceHeaders` | `true` | `x-trace-id`, `x-span-id`, `x-parent-span-id`, `x-correlation-id`, `x-causation-id` |
| `serializer` | `'json'` | `'text'`, `'form'` (`x-www-form-urlencoded`), o función / instancia / ref que devuelve `{ body, contentType }` o un string |
| `response` | `'full'` | `'body'`, o un mapper que recibe `{ response, request, payload, message, target, attempts, durationMs }` |
| `timeoutMs` | `30000` | por intento; `0` lo desactiva; llamada > target > binding > módulo |
| `idempotency` | reenvía la key del mensaje | ver abajo; `false` no envía key |
| `retry` | apagado | ver abajo |
| `mapError` | — | recibe `OutboundHttpError` / `OutboundNetworkError` / `OutboundTimeoutError`; lo que devuelve se lanza |
| `fetchFn` | `globalThis.fetch` | inyectable; sin dependencia de cliente HTTP |

Precedencia de headers, de menor a mayor: content type del serializer, headers estáticos, headers de
traza, headers del `target`, `mapHeaders`, headers de la llamada, header de idempotencia. Los nombres
se comparan sin distinguir mayúsculas, así que tu `X-Correlation-ID` reemplaza al `x-correlation-id`
de traza en vez de enviarse dos veces.

**Idempotency key.** **Nunca se genera** una key. Por defecto se envía como `Idempotency-Key` el
header `idempotencyKey` del mensaje (el que reenvió un adaptador inbound). `header` lo renombra;
`key` resuelve una key estable a partir del mensaje (un string, o partes que se escapan y se unen con
`:`) y apaga el reenvío salvo `forward: true`; `idempotencyKey` en el target o en la llamada gana
sobre el resolver; `idempotency: false` no envía nada.

**Reintentos.** Apagados salvo que se configure `retry`. `{ maxAttempts = 3, backoff, retryOn, methods }`:
un fallo se reintenta solo si se clasifica como reintentable (default: errores de red, timeouts, HTTP
408, 429 y 5xx) **y** el método es seguro de repetir: GET, HEAD u OPTIONS, cualquier método mientras
se envía una idempotency key, o un método listado en `methods`. El request se construye una sola vez,
así que todos los intentos llevan la misma key. `backoff` es un delay fijo,
`{ initialMs = 200, factor = 2, maxMs = 10000 }` o una función; el error mapper corre una vez, tras
el último intento.

**Errores.** Los tres extienden `OutboundRestError` (`kind`, `binding`, `url`, `method`, `attempts`):
`OutboundHttpError` agrega `status`, `statusText`, `headers` y el `body` parseado;
`OutboundNetworkError` agrega `code` (`ECONNREFUSED`, `ENOTFOUND`, …) y `cause`;
`OutboundTimeoutError` agrega `timeoutMs`. Una mala configuración lanza `OutboundError` al declarar el
binding (en el arranque), no en el primer mensaje.

**Observabilidad.** Una línea de arranque por binding
(`outbound rest: payments.http -> POST https://pay.example/charges`, o `-> dynamic`), los bindings de
canal quedan en el grafo (`outbounds` en el nodo, una arista `outbound`, una línea Mermaid) y una
línea de hop por llamada cuando `logging.hops` está activo. Nunca se registran bodies, headers,
valores de key, query strings ni credenciales de la url; los mensajes de error llevan la url sin su
query string (`error.url` conserva la completa).

Advertencias: las estrategias resuelven solo providers singleton; `{ useExisting }` y la configuración
se validan en el arranque para los bindings declarados y en la primera llamada para opciones ad-hoc
(guárdalas en una constante para reutilizar el plan); un response mapper que lanza no pasa por
`mapError`; el timeout aplica a cada intento, no a toda la secuencia de reintentos; el backoff por
defecto no respeta `Retry-After` (usa una función de backoff).

## Observabilidad

```bash
curl localhost:3000/integration/graph          # nodes · edges · flows (JSON)
curl localhost:3000/integration/graph/mermaid  # topología como Mermaid
```

```mermaid
flowchart LR
  orders_place["direct: orders.place"] -->|wireTap| orders_audit["queue: orders.audit"]
  orders_place -->|jump · place-order| inventory_reserve["direct: inventory.reserve"]
  orders_place -->|publish · rk:order.placed| domain_events["pubsub: domain.events"]
  inventory_reserve --> act["activator: InventoryActivator.reserve"]
```

El log de arranque lista cada punto de entrada cableado: una línea por activator y una por
endpoint inbound anotado (`@InboundRest` / `@InboundGrpc` / `@InboundGraphQL`); cada inbound
queda además registrado en el graph:

```
activator: InventoryActivator.reserve -> inventory.reserve
inbound rest: POST /V1/Workflows/:id/Start -> wf.start (request-reply)
inbound grpc: WorkflowLifecycleService/Start -> wf.start (request-reply)
inbound graphql: mutation placeOrder -> orders.place
```

Solo se imprimen transporte, ruta o patrón, canal y el flag request-reply. Si la metadata de
ruta no se puede leer, la línea usa `Class.method`. El warning de `AMQP_CHANNEL` ausente solo
se emite cuando hay `rabbitMappings` declarados sin `rabbitChannel`.

## Arquitectura

Hexagonal (puertos y adaptadores) con SOLID y GoF explícitos:
`FlowStep` = **Command** · `FlowExecutor` = **Template Method** · `IntegrationFlow` = **Builder** ·
`FanoutChannel` = **Composite** · `ChannelRegistry` = **Mediator** · canales/stores = **Strategy** ·
`nextHop` = **Prototype** · `NoopIdempotencyStore` = **Null Object** · canales efímeros = **Proxy**.

```text
interface (decorators · interceptor · controller · module · testing)
        ↓
application (flow-executor · activator-wrapper · registry · gateway · graph)
        ↓
domain (message · channel · flow-step)          ← cero dependencias, enforced
        ↳ infrastructure: canales in-memory · memory store · rest/grpc/rabbit adapters
```

Motor event-driven 100% nativo Node ≥ 18: `node:events` · `AsyncLocalStorage` +
`AsyncResource.bind` · `AbortSignal.timeout` · `Promise.all/allSettled` · `setImmediate` ·
`OnApplicationShutdown` (drain de queues).

## Testing

```ts
import { bindFlow, createTestMessage, waitFor, MemoryIdempotencyStore } from '@estela/nest/testing';

bindFlow(PlaceOrderFlow, registry, { idempotency: new IdempotencyService({ store: new MemoryIdempotencyStore() }) });
await registry.send('orders.place', { qty: 2, sku: 'A' });
const reply = await waitFor(registry, 'reply.http-1', 2_000);
```

## Estado

| | |
|---|---|
| Tests | **421/421** · 31 suites · e2e HTTP real |
| Spec | 10/10 tests mínimos · DoD §15 completo |
| Boundaries | dominio puro · barrel sin brokers · testing sin inbound (0 violaciones) |
| Build | ESM + CJS + d.ts · Node ≥ 18 |

Example runnable: [`src/example/`](./src/example) · Scripts: `npm run verify` (typecheck → build → test → bounds).

---

<div align="center">

<sub>**ESTELA** — construida con ☄️ por [**DYDD Technologies**](https://www.dyddtech.com) · creada y mantenida por [**Eliu Diaz**](https://www.linkedin.com/in/eliudiaz) · único mantainer [@eliudiaz-dydd](https://github.com/eliudiaz-dydd)</sub>

</div>

## Licencia

MIT
