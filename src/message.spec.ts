import {
  copyMessage,
  createMessage,
  newId,
  nextHop,
  recordHop,
  type IntegrationMessage,
} from './message';

describe('createMessage', () => {
  it('genera id, traceId=id, spanId, correlationId=id e history vacío', () => {
    const msg = createMessage({ qty: 2 });
    expect(msg.payload).toEqual({ qty: 2 });
    expect(msg.headers.id).toBeTruthy();
    expect(msg.headers.traceId).toBe(msg.headers.id);
    expect(msg.headers.correlationId).toBe(msg.headers.id);
    expect(msg.headers.spanId).not.toBe(msg.headers.id);
    expect(msg.headers.history).toEqual([]);
  });

  it('respeta headers provistos y copia opcionales + extras', () => {
    const msg = createMessage('p', {
      traceId: 't-1',
      correlationId: 'c-1',
      replyChannel: 'reply.http-1',
      idempotencyKey: 'idem-1',
      jumpReplies: { a: 1 },
      tenant: 'acme',
    });
    expect(msg.headers.traceId).toBe('t-1');
    expect(msg.headers.correlationId).toBe('c-1');
    expect(msg.headers.replyChannel).toBe('reply.http-1');
    expect(msg.headers.idempotencyKey).toBe('idem-1');
    expect(msg.headers.jumpReplies).toEqual({ a: 1 });
    expect(msg.headers.tenant).toBe('acme');
  });
});

describe('nextHop', () => {
  const base = (): IntegrationMessage<{ qty: number }> =>
    createMessage(
      { qty: 2 },
      {
        traceId: 'trace-1',
        correlationId: 'corr-1',
        replyChannel: 'reply.inbound',
        idempotencyKey: 'key-1',
        jumpReplies: {},
      },
    );

  it("default 'inherit' conserva contexto y crea nuevo hop (spec §4)", () => {
    const prev = base();
    const next = nextHop(prev, { channel: 'orders.persist' });
    expect(next.headers.traceId).toBe('trace-1');
    expect(next.headers.correlationId).toBe('corr-1');
    expect(next.headers.replyChannel).toBe('reply.inbound');
    expect(next.headers.idempotencyKey).toBe('key-1');
    expect(next.headers.causationId).toBe(prev.headers.id);
    expect(next.headers.parentSpanId).toBe(prev.headers.spanId);
    expect(next.headers.id).not.toBe(prev.headers.id);
    expect(next.headers.spanId).not.toBe(prev.headers.spanId);
    expect(next.headers.history).toHaveLength(1);
    expect(next.headers.history[0]?.channel).toBe('orders.persist');
    expect(typeof next.headers.history[0]?.at).toBe('number');
  });

  it('no muta el mensaje de entrada (inmutabilidad del plan §5.3)', () => {
    const prev = base();
    const snapshot = structuredClone(prev);
    nextHop(prev, { channel: 'x', component: 'FilterStep' });
    expect(prev).toEqual(snapshot);
    expect(prev.headers.history).toHaveLength(0);
  });

  it("reply:'none' elimina replyChannel (wireTap/fanout/publish — plan §8.1)", () => {
    const next = nextHop(base(), { channel: 'x' }, { reply: 'none' });
    expect(next.headers.replyChannel).toBeUndefined();
    expect('replyChannel' in next.headers).toBe(false);
  });

  it("reply:'<canal>' fija reply efímero (jump — plan §8.1)", () => {
    const next = nextHop(base(), { channel: 'x' }, { reply: 'reply.jump-1' });
    expect(next.headers.replyChannel).toBe('reply.jump-1');
  });

  it('inherit sin replyChannel previo no crea la key', () => {
    const bare = createMessage('p');
    const next = nextHop(bare, { channel: 'x' });
    expect(next.headers.replyChannel).toBeUndefined();
    expect('replyChannel' in next.headers).toBe(false);
  });

  it('conserva jumpReplies y headers custom', () => {
    const prev = base();
    (prev.headers as Record<string, unknown>).tenant = 'acme';
    const next = nextHop(prev, { channel: 'x' });
    expect(next.headers.jumpReplies).toEqual({});
    expect(next.headers.tenant).toBe('acme');
  });
});

describe('copyMessage (wireTap)', () => {
  it('mismo id; history clonado a array nuevo', () => {
    const msg = createMessage('p');
    const copy = copyMessage(msg);
    expect(copy.headers.id).toBe(msg.headers.id);
    expect(copy.headers.history).not.toBe(msg.headers.history);
    copy.headers.history.push({ channel: 'tap', at: 1 });
    expect(msg.headers.history).toHaveLength(0);
  });
});

describe('recordHop', () => {
  it('misma id + hop anexado sin mutar la entrada', () => {
    const msg = createMessage('p');
    const rec = recordHop(msg, { channel: 'orders.audit', adapter: 'rest' });
    expect(rec.headers.id).toBe(msg.headers.id);
    expect(rec.headers.history).toHaveLength(1);
    expect(rec.headers.history[0]?.adapter).toBe('rest');
    expect(msg.headers.history).toHaveLength(0);
  });
});

describe('newId', () => {
  it('genera ids únicos', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) ids.add(newId());
    expect(ids.size).toBe(1000);
  });
});
