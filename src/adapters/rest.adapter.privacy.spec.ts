import { bindRestOut, type RestFetch } from './rest.adapter';
import { ChannelRegistry } from '../channel-registry';
import { TraceContext } from '../trace/trace-context';

describe('SD-05 restOut errors (S11)', () => {
  it('restOut error message carries no query string or userinfo', async () => {
    const registry = new ChannelRegistry({ trace: new TraceContext() });
    const failFetch: RestFetch = () =>
      Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') });
    registry.create({ name: 'http.fail', type: 'direct' });
    bindRestOut(registry, 'http.fail', {
      url: 'https://u:p@h.example/x?token=CANARY-SECRET-0001#frag',
      fetchFn: failFetch,
    });
    const error = await registry.send('http.fail', {}).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('https://h.example/x');
    expect(error?.message).toContain('500');
    expect(error?.message).not.toContain('CANARY-SECRET-0001');
    expect(error?.message).not.toContain('u:p@');
    expect(error?.message).not.toContain('?');
  });
});
