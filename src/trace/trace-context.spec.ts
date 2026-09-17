import { createMessage, type MessageHeaders } from '../message';
import { TraceContext } from './trace-context';

describe('TraceContext', () => {
  it('run/current: contexto vivo dentro, undefined fuera', () => {
    const ctx = new TraceContext();
    expect(ctx.current()).toBeUndefined();
    const inside = ctx.run({ traceId: 't', spanId: 's', correlationId: 'c' }, () => ctx.current());
    expect(inside?.traceId).toBe('t');
    expect(ctx.current()).toBeUndefined();
  });

  it('ALS propaga a branches de Promise.all (garantía fanout — plan §8.6)', async () => {
    const ctx = new TraceContext();
    const traceIds = await ctx.run(
      { traceId: 't-42', spanId: 's', correlationId: 'c' },
      async () => {
        const [a, b] = await Promise.all([
          (async () => ctx.current()?.traceId)(),
          (async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return ctx.current()?.traceId;
          })(),
        ]);
        return [a, b];
      },
    );
    expect(traceIds).toEqual(['t-42', 't-42']);
  });

  it('el contexto NO cruza un setImmediate fuera del run (por eso el dispatcher reconstruye desde headers)', async () => {
    const ctx = new TraceContext();
    ctx.run({ traceId: 't', spanId: 's', correlationId: 'c' }, () => undefined);
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        expect(ctx.current()).toBeUndefined();
        resolve();
      });
    });
  });

  it('runWithMessage/fromHeaders derivan el contexto del mensaje', () => {
    const ctx = new TraceContext();
    const msg = createMessage('p', { traceId: 't', correlationId: 'c', parentSpanId: 'p0' });
    const seen = ctx.runWithMessage(msg, () => ctx.current());
    expect(seen).toMatchObject({ traceId: 't', correlationId: 'c', parentSpanId: 'p0' });
  });

  it('bindMessage completa faltantes desde el ambiente y NO muta la entrada', () => {
    const ctx = new TraceContext();
    const raw = {
      id: 'm-1',
      timestamp: 1,
      correlationId: '',
      traceId: '',
      spanId: '',
      history: [],
    } as unknown as MessageHeaders;
    const msg = { payload: 'p', headers: raw };
    const bound = ctx.run({ traceId: 't-amb', spanId: 's-amb', correlationId: 'c-amb' }, () =>
      ctx.bindMessage(msg),
    );
    expect(bound.headers.traceId).toBe('t-amb');
    expect(bound.headers.spanId).not.toBe('');
    expect(bound.headers.correlationId).toBe('m-1'); // fallback = id (spec §4)
    expect(bound.headers.parentSpanId).toBe('s-amb');
    expect(msg.headers.traceId).toBe(''); // entrada intacta
  });

  it('bindMessage sin ambiente: traceId/correlation caen al id', () => {
    const ctx = new TraceContext();
    const raw = {
      id: 'm-2',
      timestamp: 1,
      correlationId: '',
      traceId: '',
      spanId: '',
      history: [],
    } as unknown as MessageHeaders;
    const bound = ctx.bindMessage({ payload: null, headers: raw });
    expect(bound.headers.traceId).toBe('m-2');
    expect(bound.headers.correlationId).toBe('m-2');
    expect(bound.headers.spanId).not.toBe('');
    expect(bound.headers.parentSpanId).toBeUndefined();
  });

  it('bindMessage respeta trazas ya presentes y completa parentSpan con el ambiente', () => {
    const ctx = new TraceContext();
    const msg = createMessage('p', { traceId: 'keep', correlationId: 'keep-c' });
    const bound = ctx.run({ traceId: 'other', spanId: 'o-s', correlationId: 'o-c' }, () =>
      ctx.bindMessage(msg),
    );
    expect(bound.headers.traceId).toBe('keep');
    expect(bound.headers.correlationId).toBe('keep-c');
    expect(bound.headers.parentSpanId).toBe('o-s');
  });
});
