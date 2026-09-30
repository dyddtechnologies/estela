import { Test } from '@nestjs/testing';
import { Injectable, Logger } from '@nestjs/common';
import { IntegrationModule } from '../integration.module';
import { IntegrationFlow, type FlowDefinition } from '../flow/integration-flow';
import { ServiceActivator } from '../decorators';
import { ChannelRegistry } from '../channel-registry';
import { HopLogger } from './hop-logger';

@Injectable()
class Echo {
  @ServiceActivator('demo.work')
  work(): string {
    return 'done';
  }
}

const DemoFlow: FlowDefinition = {
  name: 'demo-flow',
  build: () =>
    IntegrationFlow.from('demo.in')
      .jumpTo([{ channel: 'demo.work', timeoutMs: 1000 }])
      .reply(),
};

describe('HopLogger', () => {
  it('is off by default (no hop lines emitted)', async () => {
    const lines: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((m: unknown) => lines.push(String(m)) as unknown as void);
    const mod = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            channels: [
              { name: 'demo.in', type: 'direct' },
              { name: 'demo.work', type: 'direct' },
            ],
          },
          [DemoFlow],
        ),
      ],
      providers: [Echo],
    }).compile();
    await mod.init();
    await mod.get(ChannelRegistry).send('demo.in', { hello: 'world' });
    spy.mockRestore();
    expect(lines.some((l) => /^(▶|→) (flow|hop) /.test(l))).toBe(false);
    await mod.close();
  });

  it('brackets each flow and hop, distinguishing flow / channel / correlation', async () => {
    const lines: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((m: unknown) => lines.push(String(m)) as unknown as void);
    const mod = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            channels: [
              { name: 'demo.in', type: 'direct' },
              { name: 'demo.work', type: 'direct' },
            ],
            logging: { hops: true },
          },
          [DemoFlow],
        ),
      ],
      providers: [Echo],
    }).compile();
    await mod.init();
    await mod.get(ChannelRegistry).send('demo.in', { hello: 'world' });
    spy.mockRestore();

    const hop = lines.filter((l) => /^(▶|■|→|←) (flow|hop) /.test(l));
    expect(hop.some((l) => l.startsWith('▶ flow demo-flow on demo.in') && l.includes('trace='))).toBe(true);
    expect(hop.some((l) => l.startsWith('→ hop demo.work activator:Echo.work') && l.includes('corr='))).toBe(true);
    expect(hop.some((l) => l.startsWith('← hop demo.work activator:Echo.work ok'))).toBe(true);
    expect(hop.some((l) => l.startsWith('■ flow demo-flow on demo.in completed'))).toBe(true);
    await mod.close();
  });

  it('formats a hop line with trace and correlation', () => {
    const emitted: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => emitted.push(String(m)) as unknown as void);
    const h = new HopLogger('log');
    const headers = { traceId: 't-1', correlationId: 'c-1' } as never;
    h.hopStart('ch.x', 'activator:A.b', headers);
    expect(emitted[0]).toBe('→ hop ch.x activator:A.b [trace=t-1 corr=c-1]');
    jest.restoreAllMocks();
  });
});
