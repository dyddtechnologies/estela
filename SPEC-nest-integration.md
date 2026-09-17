# Spec: `@acme/nest-integration`

Módulo NestJS derivable (EIP / homónimo de Spring Integration).  
Documento para un coding agent: implementar una librería publicable, no una app.

Idioma del código: TypeScript estricto.  
Idioma de este spec: español. APIs en inglés.

---

## 1. Objetivo

Entregar un paquete npm que una app Nest importe así:

```ts
IntegrationModule.forRoot({ channels, idempotency }, [PlaceOrderFlow])
```

El runtime cablea canales, flows, inbound adapters (REST/gRPC/Rabbit), activators, trazas, idempotencia y un grafo inspectable.

Principio: **el flow habla con canales, no con clases**. Las clases se enganchan con decoradores. El payload viaja en `IntegrationMessage.payload`; los hops copian headers (`traceId`, `replyChannel`, `idempotencyKey`, `history`).

## 2. No objetivos

- No reimplementar Spring Integration ni Camel.
- No depender de `@nestjstools/messaging`, `@nestjs/cqrs`, KafkaJS, amqplib como deps de implementación.
- No ESB central ni DSL XML.
- No persistir canales in-memory como si fueran brokers. In-memory es default; brokers son puertos.
- No OpenTelemetry completo (sí headers compatibles).

## 3. Package

Nombre sugerido: `@acme/nest-integration` (el implementador puede renombrar).

Peer dependencies:

- `@nestjs/common`, `@nestjs/core` ^10 || ^11
- `@nestjs/swagger` ^7 || ^8 (peer, usado por `@InboundRest`)
- `reflect-metadata`, `rxjs`

Optional peers (solo tipos / adapters):

- `amqplib` — no importar en el entrypoint
- `@grpc/grpc-js` — no importar en el entrypoint

Exports:

```
@acme/nest-integration
@acme/nest-integration/testing
```

Estructura:

```
src/
  message.ts
  channel.ts
  channel-registry.ts
  channels/{direct,queue,pubsub,fanout}.channel.ts
  flow/integration-flow.ts
  decorators.ts
  inbound/{inbound.types,inbound.decorators,inbound.interceptor,inbound.explorer,inbound.swagger}.ts
  adapters/{header-mapper,rest.adapter,grpc.adapter,rabbit.adapter}.ts
  idempotency/{idempotency-store,memory-idempotency.store,idempotency.service}.ts
  trace/trace-context.ts
  gateway/reply-gateway.ts
  graph/{channel-graph,channel-graph.controller}.ts
  integration.module.ts
  index.ts
  testing/index.ts
```

`IntegrationModule.forRoot` es `global: true`.

---

## 4. Contratos de mensaje

```ts
interface HistoryHop {
  channel: string;
  component?: string;
  adapter?: string;
  at: number;
}

interface MessageHeaders {
  id: string;
  timestamp: number;
  correlationId: string;
  causationId?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  replyChannel?: string;
  errorChannel?: string;
  routingKey?: string;
  contentType?: string;
  source?: string;
  idempotencyKey?: string;
  history: HistoryHop[];
  jumpReplies?: Record<string, unknown>;
  [key: string]: unknown;
}

interface IntegrationMessage<T = unknown> {
  payload: T;
  headers: MessageHeaders;
}
```

Helpers obligatorios: `createMessage`, `copyMessage`, `nextHop`, `recordHop`, `newId`.

Reglas:

- `createMessage` genera `id`, `traceId` (fallback = id), `spanId`, `correlationId` (fallback = id), `history: []`.
- `nextHop` conserva `traceId`, `correlationId`, `replyChannel`, `idempotencyKey`, `jumpReplies`; nuevo `id` y `spanId`; `causationId = msg.headers.id`; `parentSpanId = msg.headers.spanId`; append hop a `history`.
- `copyMessage` no cambia id (wireTap).

Headers HTTP/gRPC/AMQP:

| Protocolo | Header |
|---|---|
| x-trace-id | traceId |
| x-span-id | spanId |
| x-parent-span-id | parentSpanId |
| x-correlation-id | correlationId |
| x-causation-id | causationId |
| idempotency-key / x-idempotency-key | idempotencyKey |

---

## 5. Canales

```ts
type ChannelKind = 'direct' | 'queue' | 'pubsub' | 'fanout';

interface MessageChannel {
  readonly name: string;
  readonly kind: ChannelKind;
  send(msg: IntegrationMessage): Promise<void>;
  subscribe(handler: MessageHandlerFn, options?: SubscribeOptions): Unsubscribe;
}

interface SubscribeOptions {
  group?: string;
  routingKey?: string;
}
```

| Tipo | Semántica |
|---|---|
| direct | 1 subscriber; `send` await el handler. Si no hay subscriber → throw |
| queue | buffer + round-robin; capacity configurable |
| pubsub | broadcast; `routingKey` glob `*` un segmento, `#` resto; `group` = un consumidor del grupo |
| fanout | copia a bindings (otros canales) + subscribers locales; sin filtro |

`ChannelRegistry`:

- `create(spec)`, `register`, `get`, `tryGet`, `fanout(name)`, `list`
- `send(channel, payload, headers?)` → `createMessage` + bind de `TraceContext` + `recordHop` + `send`
- `sendMessage(channel, msg)` → bind trace + `recordHop({ channel })` + `send`

Declaración en `forRoot`:

```ts
{ name: 'orders.place', type: 'direct' }
{ name: 'orders.audit', type: 'queue', capacity: 10_000 }
{ name: 'domain.events', type: 'pubsub' }
{ name: 'ops.fanout', type: 'fanout', bindings: ['inventory.reserve', 'billing.charge'] }
```

Auto-crear `errorChannel` default `'error.channel'` tipo `pubsub` si no existe.

---

## 6. DSL de flows

```ts
interface FlowDefinition {
  name: string;
  build(): IntegrationFlow;
}

IntegrationFlow.from(sourceChannel)
  .filter(predicate)
  .transform(fn)
  .handle(fn)
  .wireTap(channel)
  .fanoutTo(dests)
  .jumpTo(dests)
  .jump(channel, opts?)
  .publish(channel, routingKey?)
  .route(fn)
  .to(channel)
  .reply()
  .inspect()
  .bind(deps)
```

### 6.1 Payload threading

Un `let msg` por invocación.

- `filter`: lee `msg.payload`. false → exit (idempotency succeed `{ filtered: true }`).
- `transform`: si return tiene `{ payload, headers }` reemplaza `msg`; si no, `msg = { payload: out, headers: msg.headers }` + `recordHop`.
- `handle`: si return !== undefined, pisa `payload`. No dispara reply salvo que se documente lo contrario; el reply explícito es `.reply()`.
- Destinos (wireTap/fanout/jump/publish/to/route) reciben copia u hop del `msg` actual. El return de un activator **no** pisa el payload del flow.

### 6.2 Destinos mixtos

```ts
interface FanoutTarget {
  channel: string;
  wait?: boolean;      // default true
  timeoutMs?: number;  // solo jump wait
}

type FanoutDest = string | FanoutTarget;
// string ≡ { channel, wait: true }
```

**wireTap(channel)**  
`copyMessage` + `void send.catch(() => undefined)`. Nunca falla el flow. No espera.

**fanoutTo(dests)**  
Copia con `nextHop`.  
`wait !== false` → `Promise.all` de esos `send` (espera handler si el canal es direct).  
`wait: false` → `void send`; error → `error.channel` con `{ fireAndForget: true, channel }`.  
El grupo awaited corre en paralelo. El pipeline sigue cuando el grupo awaited termina. Forget no bloquea.

**jumpTo(dests) / jump(channel, opts)**  
Igual que fanout en forget.  
`wait !== false`: crear `DirectChannel('reply.<uuid>')`, set `hop.headers.replyChannel`, `send`, await primer mensaje o timeout (default 10s). Resultado en `msg.headers.jumpReplies[channel]`. Payload del flow no se reemplaza. Timeouts/errores awaited fallan el flow.

Los destinos responden así:

- `@ServiceActivator` que `return` un valor + el wrapper envía a `replyChannel`.
- o el flow destino llama `.reply()`.

**publish(channel, routingKey?)**  
`nextHop` + set `routingKey`. No corta el pipeline. Await el send (el channel pubsub no espera consumidores de negocio más allá del dispatch).

**to(channel)**  
`nextHop` + send + **termina** el pipeline (después puede ir `.reply()` si se implementa como step posterior — ver 6.3).

**route(fn)**  
fn → `string | string[]`. `nextHop` a cada uno. Termina el pipeline.

### 6.3 `.reply()` (obligatorio en esta implementación)

Step que no corta por sí solo si se pone al final:

```
if (msg.headers.replyChannel) {
  await registry.send(replyChannel, msg.payload, {
    correlationId, traceId, causationId: msg.headers.id, parentSpanId: spanId
  });
}
```

Orden recomendado: `... .to('orders.persist').reply()` no funciona si `to` termina antes. Definir:

- `.to(channel)` termina **después** de enviar.
- `.reply()` debe poder usarse **antes** de `to` o como último step sin `to`.

Contrato final:

1. Si el último step es `.reply()`, envía `msg.payload` al `replyChannel` y termina.
2. Si hay `.to()` y luego no hay reply, el reply queda a cargo de un activator en el canal destino (si retorna).
3. Documentar que para “responder al HTTP al final del flow” el patrón es:

```ts
.handle(persistFn) // opcional
.reply()
.to('orders.persist') // solo si to NO debe ser la fuente del HTTP reply
```

Implementar `.reply({ payload?: 'current' | 'jumpMerge' })`.  
`jumpMerge`: payload = `{ ...payload, jumpReplies }`.

Default `'current'`.

Activators **no** deben auto-reply si el header `replyChannel` fue puesto por un **jump** intermedio… Conflicto.

Regla de precedencia (implementar sí o sí):

- Jump crea reply channels **efímeros propios**. El hop del jump lleva ese `replyChannel`.
- El `msg` del pipeline padre **conserva** el `replyChannel` original del inbound (no pisarlo en el padre).
- `nextHop` para fanout/publish/to: **sí** copia el replyChannel del padre (riesgo de reply prematuro).
- `nextHop` para **jump**: el hop usa el reply efímero, no el del padre.

Fanout wait:true **no** debe copiar `replyChannel` del inbound a los destinos (evitar que `reserve()` cierre el HTTP). Copiar solo en jump hops (reply efímero) y en el `.reply()` / activator terminal del padre.

Implementar `nextHop(msg, hop, { reply?: 'inherit' | 'none' | string })`:

- fanout/wireTap/publish: `reply: 'none'`
- to/route: `reply: 'inherit'` (el activator destino puede cerrar inbound)
- jump: `reply: replyName`

### 6.4 Errores e idempotencia del flow

Scope: `flow:${flowName}`.

- acquire al entrar.
- succeed al terminar o filter out.
- fail + send `error.channel` en throw (incluye jump timeout).
- `DuplicateMessageError` en acquire → silenciar (el inbound replay ya cubre HTTP).

`inspect()` devuelve `{ source, steps[] }` sin funciones.

`bind({ registry, errorChannel, flowName, idempotency, trace })`.

---

## 7. Decoradores de aplicación

### 7.1 Activators

```ts
@ServiceActivator(channel, { group?, routingKey? })
@PubSub(channel, { routingKey?, group? })  // alias
```

Firma: `(payload, msg: IntegrationMessage) => unknown | Promise<unknown>`.

Wrapper del módulo:

1. `TraceContext.run` con headers del msg.
2. Idempotency scope `activator:Class.method`.
3. Llama método.
4. succeed / fail.
5. Si `return !== undefined` **y** `msg.headers.replyChannel` → `registry.send(replyChannel, result, trace headers)`.
6. Duplicate + cachedResult + replyChannel → reenvía cache.
7. Otros errores → `error.channel`.

### 7.2 Inbound en controllers (no en forRoot)

```ts
@InboundRest(spec)
@InboundGrpc(spec)
@InboundRabbit(spec)
@Inbound({ transport, ...spec })
```

```ts
interface InboundSpec {
  channel: string;
  transport: 'rest' | 'grpc' | 'rabbit';
  requestReply?: boolean;
  timeoutMs?: number;
  payload?: 'return' | 'body'; // default return (fallback body)
  swagger?: boolean;           // default true en REST
}
```

REST/gRPC: `SetMetadata` + `UseInterceptors(InboundInterceptor)`.

Interceptor:

1. Ejecuta el handler Nest (pipes/guards).
2. Payload = return ?? body (o body si `payload:'body'`).
3. Mapea headers de protocolo.
4. `requestReply` → `ReplyGateway.sendAndReceive`.
5. si no → `registry.sendMessage`.
6. Respuestas:
   - accepted: `{ status:'accepted', id, traceId, correlationId }` (+ merge si el handler devolvió objeto)
   - reply: `{ status:'ok', result, id, traceId, correlationId, headers }`
   - duplicate: `{ status:'duplicate', idempotencyKey, replayed, result, traceId }`

Rabbit: solo metadata. `InboundExplorer` en `onModuleInit` bindea si existe token `AMQP_CHANNEL`. Si no, warn y no throw.

El usuario declara controllers Nest normales e interfaces de contrato opcionales.

### 7.3 Swagger

`@InboundRest` aplica, si `swagger !== false`:

- `ApiOperation` (canal, reply vs accepted, timeout)
- `ApiHeader` de traza e idempotencia
- `ApiAcceptedResponse` | `ApiOkResponse`
- `ApiResponse` duplicate
- `ApiExtraModels` de `InboundAcceptedDto | InboundReplyDto | InboundDuplicateDto`

El body lo documenta el usuario con `@ApiBody` + DTO.

Exportar `setupIntegrationSwagger(app)` que registre extraModels y monte `/docs` **solo si** el consumidor lo llama. El módulo no monta Swagger UI solo.

Grafo: `@ApiTags('integration-graph')` en `GET /integration/graph` y `/integration/graph/mermaid`.

---

## 8. Request/reply inbound

`ReplyGateway.sendAndReceive(channel, payload, headers, timeoutMs)`:

1. Crea `DirectChannel('reply.<uuid>')` y `register`.
2. Subscribe one-shot.
3. `sendMessage` con `replyChannel` seteado.
4. Timeout → reject.
5. Resolve con `msg.payload` del reply.

Ideal: deregister el canal efímero en `finally` (`ChannelRegistry.unregister`).

---

## 9. Adapters outbound

### REST outbound

```ts
restOut.bind('http.out.erp', { url, method?: 'POST'|'PUT'|'PATCH' })
```

`fetch` JSON + headers de traza/idempotencia. !ok → throw (el subscriber del canal propaga).

### gRPC

```ts
grpcIn.handleInbound(channel, data, metadata, requestReply?)
grpcOut.bind(fromChannel, (payload, meta) => stub.method(payload, meta), replyChannel?)
```

Sin importar `@grpc/grpc-js`.

### Rabbit

Interfaz `AmqpLikeChannel` (assertQueue, consume, ack, nack, sendToQueue, publish?).  
Inbound: parse JSON, map headers AMQP, `recordHop` adapter `rabbit-inbound`, send al canal, ack; fail → nack(requeue false).  
Outbound: bind fromChannel → queue o exchange+routingKey; persistent; headers de traza.

Token `AMQP_CHANNEL` opcional.

---

## 10. Trazas e idempotencia

`TraceContext`: `AsyncLocalStorage`. `run`, `current`, `fromHeaders`, `bindMessage` (completa trace/correlation/parentSpan si faltan).

`IdempotencyStore`:

```ts
begin(scope, key, ttlMs): Promise<boolean>  // false si existe y no expiró
complete(scope, key, result): Promise<void>
fail(scope, key, error): Promise<void>
get(scope, key): Promise<Record | undefined>
purgeExpired(): Promise<number>
```

Default `MemoryIdempotencyStore`.  
`forRoot({ idempotency: { enabled, ttlMs, store } })`.  
`enabled: false` → store null; acquire es no-op.  
Sin `idempotencyKey` en el mensaje → no-op.

Clave de almacenamiento: `${scope}::${key}`.

---

## 11. Module API

```ts
IntegrationModule.forRoot(options, flows?: FlowDefinition[]): DynamicModule

interface IntegrationModuleOptions {
  channels: ChannelSpec[];
  errorChannel?: string; // default 'error.channel'
  idempotency?: { enabled?: boolean; ttlMs?: number; store?: IdempotencyStore };
}
```

Providers exportados:  
`ChannelRegistry`, `TraceContext`, `ReplyGateway`, `IdempotencyService`, `ChannelGraph`, adapters inbound/outbound REST/gRPC/Rabbit, `InboundInterceptor`.

Controllers del módulo: `ChannelGraphController` únicamente.

`onModuleInit` orden:

1. crear error channel + channels
2. suscribir activators (providers)
3. `graph.recordFlow` + `flow.bind` para cada FlowDefinition
4. `InboundExplorer` (otro OnModuleInit) bindea Rabbit

`DiscoveryModule` importado.

---

## 12. Grafo

`ChannelGraph.snapshot()`:

```ts
{
  nodes: [{ channel, kind, bindings?, inbounds[], activators[], flowsFrom[] }],
  edges: [{ from, to, via, wait?, routingKey?, flow? }],
  flows: [{ name, source, steps }],
  mermaid: string
}
```

Edges: inbound→channel, flow source, wireTap, fanout, jump, publish, to, route, fanout-binding, activator/pubsub.

`GET /integration/graph`  
`GET /integration/graph/mermaid`

---

## 13. App de ejemplo (dentro del repo, no publicada)

Reproducir orders:

Canales:  
`orders.place` direct, `orders.persist` direct, `orders.audit` queue, `inventory.reserve` direct, `billing.charge` direct, `domain.events` pubsub, `orders.local|us|intl` queue, `http.out.erp` direct, `error.channel` pubsub.

Flows:

```ts
PlaceOrderFlow:
  from orders.place
  filter qty>0 && sku
  transform → { orderId, ...cmd, total: qty*10 }
  wireTap orders.audit
  jumpTo [
    { inventory.reserve, wait:true, timeoutMs:3000 },
    { billing.charge, wait:true, timeoutMs:3000 },
    { http.out.erp, wait:false },
  ]
  publish domain.events order.placed
  reply()
  to orders.persist

RouteByCountryFlow:
  from orders.persist
  route GT→orders.local, US→orders.us, else orders.intl
```

Controllers con `@InboundRest` + `@ApiTags` + `PlaceOrderDto`.  
Activators como en el prototipo.  
No meter rutas inbound en `forRoot`.

---

## 14. Testing (`/testing`)

Exportar:

- `createTestMessage(payload, headers?)`
- `MemoryIdempotencyStore`
- helper `bindFlow(flow, registry)` 
- `waitFor(channel, timeout)` para reply tests

Tests mínimos (Jest):

1. filter descarta qty 0 y no llama activators.
2. transform cambia payload; headers.traceId se conserva.
3. wireTap no bloquea si audit throw.
4. fanout wait:true espera ambos; wait:false no retrasa.
5. jump wait:true llena `jumpReplies`; timeout falla el flow.
6. jump no pisa `replyChannel` del inbound.
7. `.reply()` cierra `ReplyGateway.sendAndReceive`.
8. idempotency: segundo mensaje mismo key no re-ejecuta transform (espía).
9. pubsub routingKey `order.*` vs group competencia.
10. InboundRest requestReply false → accepted sin esperar persist.

---

## 15. Criterios de done

- [ ] Compila `strict`, packable (`nest` library o `tsup` ESM+CJS).
- [ ] Peer deps correctas; zero import de amqplib/grpc en el barrel.
- [ ] `forRoot` + example orders arrancan.
- [ ] Swagger en `@InboundRest` sin configuración extra salvo `setupIntegrationSwagger`.
- [ ] Grafo refleja jumps/fanouts/inbounds/activators.
- [ ] Tests 1–10 verdes.
- [ ] README corto: principio canales-no-clases, tabla inbound headers, ejemplo PlaceOrderFlow, cómo implementar `IdempotencyStore` Redis (contrato only).

## 16. Fuera de scope v1 (no implementar)

- Channel Kafka/BullMQ
- Redis idempotency store
- Aggregator / splitter / resequencer
- Control bus / JMX
- DSL XML
- Auto `.activate(Class, method)` en el flow

## 17. Decisiones que el agent no debe reabrir

1. Flows no importan clases de negocio.
2. Inbound se declara en métodos de controller, no en `forRoot`.
3. `fanout` espera send/handler; `jump` espera reply.
4. Forget nunca tumba el flow; awaited sí.
5. Payload del padre no lo pisan los returns de jump/fanout.
6. WireTap ignora errores.
7. Un `DirectChannel` = un subscriber. Si dos flows/activators escuchan el mismo direct, documentar que el último gana; para N consumidores usar `pubsub` o `queue`.
8. `orders.persist` no puede ser a la vez unique Direct activator y source de otro flow. En el example: `RouteByCountryFlow.from('orders.persist')` + `OrderPersistence` en el mismo direct es inválido. Corregir el example: persist activator en `orders.persist` tipo `queue` **o** el route escucha un canal distinto `orders.routed` y PlaceOrderFlow hace `.to('orders.persist')` + persist flow interno `.handle` + `.to('orders.routed')`. Preferir:

```
PlaceOrderFlow.to('orders.persist')
OrderPersistence @ServiceActivator('orders.persist') 
  y al final envía a 'orders.country' (o el persist channel es queue con un solo consumer que además send country).
RouteByCountryFlow.from('orders.country')
```

Implementar el example así para no chocar con la regla DirectChannel.

---

## 18. Prompt corto para arrancar el agent

Implementa `@acme/nest-integration` según `SPEC.md`. Empieza por message + channels + registry + flow DSL (incl. jump/reply/fanout wait) + module + decorators + inbound interceptor + tests 1–8. No agregues brokers reales. No acoples flows a clases. Entrega librería + example orders compilable.
