import 'reflect-metadata';

import { discoverActivators, subscribeActivators } from './activator/activator-wrapper';
import { ChannelRegistry } from './channel-registry';
import { ServiceActivator } from './decorators';
import { IdempotencyService } from './idempotency/idempotency.service';
import { MemoryIdempotencyStore } from './idempotency/memory-idempotency.store';
import { createMessage } from './message';
import { TraceContext } from './trace/trace-context';
import { defaultInProcessClassifier } from './resilience/classifiers';
import type { Care, CareEvent, Classification } from './resilience/resilience.types';
import { CareEngine } from './resilience/runtime';

/** A grpc-js `ServiceError`: message `<code> <NAME>: <details>`, plus code, details and metadata. */
function serviceError(code: number, name: string, details: string, metadata?: object): Error {
  return Object.assign(new Error(`${String(code)} ${name}: ${details}`), {
    code,
    details,
    metadata: metadata ?? grpcMetadata({}),
  });
}

/** A grpc-js-shaped `Metadata`: `get(key)` returns every value of the key. */
function grpcMetadata(entries: Record<string, string | Uint8Array>): object {
  return {
    get: (key: string) => (key in entries ? [entries[key]] : []),
    toJSON: () => entries,
  };
}

/** A serialized `google.rpc.Status` whose detail is a `google.rpc.QuotaFailure`. */
const QUOTA_FAILURE_BIN = new TextEncoder().encode(
  '\u0008\u0008\u0012\u0009exhausted\u001a+\n)type.googleapis.com/google.rpc.QuotaFailure',
);

describe('default in-process classifier for gRPC errors (SPI-448 gap grpc-transient)', () => {
  it('maps the gRPC status of a thrown error per the table', () => {
    const rows: [string, unknown, Classification][] = [
      [
        'UNAVAILABLE ServiceError',
        serviceError(14, 'UNAVAILABLE', 'ms-whatsapp'),
        { class: 'transient' },
      ],
      [
        'UNAVAILABLE with only a numeric code',
        Object.assign(new Error('14 UNAVAILABLE: ms-whatsapp'), { code: 14 }),
        { class: 'transient' },
      ],
      [
        'UNAVAILABLE plain status object',
        { code: 14, details: 'connection refused' },
        { class: 'transient' },
      ],
      ['UNAVAILABLE as a status field', { status: 14, message: 'down' }, { class: 'transient' }],
      ['UNAVAILABLE by name', { code: 'UNAVAILABLE', details: 'down' }, { class: 'transient' }],
      [
        'DEADLINE_EXCEEDED',
        serviceError(4, 'DEADLINE_EXCEEDED', 'Deadline exceeded after 3.001s'),
        { class: 'transient' },
      ],
      ['DEADLINE_EXCEEDED by name', { code: 'DEADLINE_EXCEEDED' }, { class: 'transient' }],
      [
        'RESOURCE_EXHAUSTED without detail',
        serviceError(8, 'RESOURCE_EXHAUSTED', 'too many requests'),
        { class: 'busy' },
      ],
      [
        'RESOURCE_EXHAUSTED with pushback',
        serviceError(
          8,
          'RESOURCE_EXHAUSTED',
          'slow down',
          grpcMetadata({ 'grpc-retry-pushback-ms': '250' }),
        ),
        { class: 'busy', readyInMs: 250 },
      ],
      [
        'RESOURCE_EXHAUSTED with a negative pushback (gRFC A6: do not try again)',
        serviceError(
          8,
          'RESOURCE_EXHAUSTED',
          'stop',
          grpcMetadata({ 'grpc-retry-pushback-ms': '-1' }),
        ),
        { class: 'rejected' },
      ],
      [
        'RESOURCE_EXHAUSTED with pushback in a plain metadata record',
        { code: 8, details: 'slow down', metadata: { 'grpc-retry-pushback-ms': ['40'] } },
        { class: 'busy', readyInMs: 40 },
      ],
      [
        'RESOURCE_EXHAUSTED whose details name a quota',
        serviceError(8, 'RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric requests'),
        { class: 'unknown' },
      ],
      [
        'RESOURCE_EXHAUSTED with a google.rpc.QuotaFailure detail',
        serviceError(
          8,
          'RESOURCE_EXHAUSTED',
          'exhausted',
          grpcMetadata({ 'grpc-status-details-bin': QUOTA_FAILURE_BIN }),
        ),
        { class: 'unknown' },
      ],
      ['an app flag wins over the code', { code: 14, retryable: false }, { class: 'rejected' }],
      [
        'INVALID_ARGUMENT stays unknown (0.9.0)',
        serviceError(3, 'INVALID_ARGUMENT', 'bad'),
        { class: 'unknown' },
      ],
      [
        'INTERNAL stays unknown (0.9.0)',
        serviceError(13, 'INTERNAL', 'boom'),
        { class: 'unknown' },
      ],
      ['a code out of the gRPC range', { code: 503 }, { class: 'unknown' }],
      [
        'a Node system error code',
        Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        { class: 'unknown' },
      ],
      ['an HTTP-like status', { status: 503 }, { class: 'unknown' }],
      [
        'a DOMException with code 14',
        new DOMException('ns', 'NamespaceError'),
        { class: 'unknown' },
      ],
      [
        'a DOMException with code 8',
        new DOMException('missing', 'NotFoundError'),
        { class: 'unknown' },
      ],
      ['a non-integer code', { code: 14.5 }, { class: 'unknown' }],
      ['null', null, { class: 'unknown' }],
    ];
    for (const [label, error, expected] of rows) {
      expect({ label, got: defaultInProcessClassifier(error) }).toEqual({ label, got: expected });
    }
  });

  it('never returns quota for any gRPC code, name, pushback or detail', () => {
    for (let code = 0; code < 17; code += 1) {
      for (const details of ['', 'quota exceeded']) {
        const error = serviceError(
          code,
          'X',
          details,
          grpcMetadata({
            'grpc-retry-pushback-ms': '5',
            'grpc-status-details-bin': QUOTA_FAILURE_BIN,
          }),
        );
        expect(defaultInProcessClassifier(error).class).not.toBe('quota');
      }
    }
    expect(
      defaultInProcessClassifier({ code: 'RESOURCE_EXHAUSTED', details: 'quota' }).class,
    ).not.toBe('quota');
  });

  it('a metadata reader that throws does not break the classification', () => {
    const metadata = {
      get: () => {
        throw new Error('broken metadata');
      },
    };
    expect(
      defaultInProcessClassifier(serviceError(8, 'RESOURCE_EXHAUSTED', 'x', metadata)),
    ).toEqual({
      class: 'busy',
    });
  });

  describe('activator', () => {
    const NO_SPACING = { firstMs: 1, growth: 1, spread: 'none' } as const;

    function boot(
      instance: object,
      channel: string,
    ): { registry: ChannelRegistry; events: CareEvent[] } {
      const trace = new TraceContext();
      const registry = new ChannelRegistry({ trace });
      registry.create({ name: 'error.channel', type: 'pubsub' });
      registry.get('error.channel').subscribe(() => undefined);
      registry.create({ name: channel, type: 'direct' });
      const events: CareEvent[] = [];
      subscribeActivators(discoverActivators([instance]), {
        registry,
        trace,
        errorChannel: 'error.channel',
        idempotency: new IdempotencyService({ store: new MemoryIdempotencyStore() }),
        care: new CareEngine({ events: { onEvent: (e) => events.push(e) } }),
      });
      return { registry, events };
    }

    function failing(channel: string, care: Care, errors: (() => Error)[]) {
      class SendActivator {
        calls = 0;

        @ServiceActivator(channel, { care })
        send(): Promise<unknown> {
          const next = errors[this.calls];
          this.calls += 1;
          return next === undefined
            ? Promise.resolve({ status: 'queued' })
            : Promise.reject(next());
        }
      }
      return new SendActivator();
    }

    it('tries a gRPC UNAVAILABLE send again without a custom classify', async () => {
      const unavailable = () => serviceError(14, 'UNAVAILABLE', 'ms-whatsapp');
      const instance = failing(
        'wa.send',
        { tries: { max: 3, requireIdempotencyKey: true, spacing: NO_SPACING } },
        [unavailable, unavailable],
      );
      const { registry, events } = boot(instance, 'wa.send');
      await registry.sendMessage(
        'wa.send',
        createMessage({ body: 'Hola' }, { idempotencyKey: 'SM01' }),
      );
      expect(instance.calls).toBe(3);
      expect(events.filter((e) => e.type === 'try.again')).toEqual([
        expect.objectContaining({ class: 'transient', tryNumber: 1 }),
        expect.objectContaining({ class: 'transient', tryNumber: 2 }),
      ]);
    });

    it('tries a RESOURCE_EXHAUSTED send again as busy', async () => {
      const exhausted = () => serviceError(8, 'RESOURCE_EXHAUSTED', 'too many requests');
      const instance = failing(
        'wa.send',
        { tries: { max: 2, idempotent: true, spacing: NO_SPACING } },
        [exhausted],
      );
      const { registry, events } = boot(instance, 'wa.send');
      await registry.sendMessage('wa.send', createMessage({ body: 'Hola' }));
      expect(instance.calls).toBe(2);
      expect(events.filter((e) => e.type === 'try.again')).toEqual([
        expect.objectContaining({ class: 'busy' }),
      ]);
    });

    it('DEADLINE_EXCEEDED is tried again only when the try is idempotent', async () => {
      const deadline = () => serviceError(4, 'DEADLINE_EXCEEDED', 'Deadline exceeded');
      const care: Care = { tries: { max: 2, spacing: NO_SPACING } };

      const withoutKey = failing('wa.send', care, [deadline]);
      const first = boot(withoutKey, 'wa.send');
      await expect(
        first.registry.sendMessage('wa.send', createMessage({ body: 'Hola' })),
      ).rejects.toThrow('DEADLINE_EXCEEDED');
      expect(withoutKey.calls).toBe(1);
      expect(first.events.map((e) => e.type)).toContain('try.held');

      const withKey = failing('wa.send', care, [deadline]);
      const second = boot(withKey, 'wa.send');
      await second.registry.sendMessage(
        'wa.send',
        createMessage({ body: 'Hola' }, { idempotencyKey: 'SM02' }),
      );
      expect(withKey.calls).toBe(2);
    });

    it('a quota detail is not tried again by default and is never classified quota', async () => {
      const quota = () => serviceError(8, 'RESOURCE_EXHAUSTED', 'Quota exceeded for project');
      const instance = failing(
        'wa.send',
        { tries: { max: 3, idempotent: true, spacing: NO_SPACING } },
        [quota],
      );
      const { registry, events } = boot(instance, 'wa.send');
      await expect(
        registry.sendMessage('wa.send', createMessage({ body: 'Hola' })),
      ).rejects.toThrow('Quota exceeded');
      expect(instance.calls).toBe(1);
      expect(events.some((e) => 'class' in e && e.class === 'quota')).toBe(false);
    });
  });
});
