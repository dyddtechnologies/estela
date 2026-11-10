import { createHash } from 'node:crypto';
import { ChannelRegistry } from '../channel-registry';
import { createMessage } from '../message';
import { TraceContext } from '../trace/trace-context';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import { TrailOutput } from '../sensitive/privacy-engine';
import { captureTrail, expectNoLeak, LeakForm, leakForms } from './index';

const SECRET = 'sk_live_4f9a8b7c6d5e';
const prefix = createHash('sha256').update(SECRET).digest('hex').slice(0, 12);

function failure(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a failure');
}

describe('privacy testing helpers (4.9)', () => {
  it('SD-38 expectNoLeak finds every encoded form', () => {
    for (const [form, needle] of leakForms(`${SECRET} /+?&"\\`)) {
      const capture = captureTrail();
      capture.logger.log(`before ${needle} after`);
      expect([
        form,
        failure(() => expectNoLeak(capture, [`${SECRET} /+?&"\\`], { forms: [form] })),
      ]).toEqual([form, expect.stringContaining(`in form ${form}`) as unknown]);
    }
    const shifted = captureTrail();
    const encoded = Buffer.concat([Buffer.from('x'), Buffer.from(SECRET)]).toString('base64');
    shifted.logger.warn(`blob ${encoded}`);
    const message = failure(() => expectNoLeak(shifted, [SECRET]));
    expect(message).toContain("trail output 'log'");
    expect(message).toContain('form base64@1');
    expect(message).toContain(`sha256:${prefix}`);
    const clean = captureTrail();
    clean.logger.log({ token: '[HIDDEN:secrets.keys]' });
    expect(() => expectNoLeak(clean, [SECRET])).not.toThrow();
    expect(() => expectNoLeak(shifted, [SECRET], { forms: [LeakForm.AsIs] })).not.toThrow();
  });

  it('SD-38 expectNoLeak never prints the secret', () => {
    const capture = captureTrail();
    capture.logger.error(SECRET);
    const message = failure(() => expectNoLeak(capture, [SECRET]));
    for (const needle of leakForms(SECRET).values()) expect(message).not.toContain(needle);
    expect(failure(() => expectNoLeak(captureTrail(), ['abc12']))).not.toContain('abc12');
    expect(failure(() => expectNoLeak(captureTrail({ keepOriginals: true }), [SECRET]))).toContain(
      'keepOriginals',
    );
  });

  it('captureTrail records store, ledger and channel writes', async () => {
    const capture = captureTrail();
    const store = capture.store(new MemoryIdempotencyStore());
    await store.begin('s', 'k', 1000);
    await store.complete('s', 'k', { cachedResult: SECRET });
    await store.fail('s', 'k2', new Error('boom'));
    const ledger = capture.ledger({
      transactional: true,
      claim: () => Promise.resolve({ status: 'new' as const }),
      record: () => Promise.resolve(),
      release: () => Promise.resolve(),
    });
    await ledger.record(null, 'saga', 'k', { reply: 1 });
    expect(ledger.transactional).toBe(true);
    const registry = new ChannelRegistry({ trace: new TraceContext() });
    registry.create({ name: 'error.channel', type: 'pubsub' });
    registry.create({ name: 'audit', type: 'pubsub' });
    const off = [capture.channel(registry, 'error.channel'), capture.channel(registry, 'audit')];
    await registry.get('error.channel').send(createMessage({ flow: 'f' }));
    await registry.get('audit').send(createMessage({ copy: 1 }));
    off.forEach((unsubscribe) => unsubscribe());
    expect(capture.writes.map((w) => [w.output, w.where])).toEqual([
      [TrailOutput.Store, 'store.complete s'],
      [TrailOutput.Store, 'store.fail s'],
      [TrailOutput.Ledger, 'ledger.record saga'],
      [TrailOutput.ErrorEnvelope, 'channel error.channel'],
      [TrailOutput.WireTap, 'channel audit'],
    ]);
    expect(capture.writes[1]?.text).toContain('boom');
    expect(() => expectNoLeak(capture, [SECRET])).toThrow(`sha256:${prefix}`);
  });
});
