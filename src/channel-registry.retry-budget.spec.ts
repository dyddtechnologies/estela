import 'reflect-metadata';

import { Injectable, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ChannelRegistry } from './channel-registry';
import { ServiceActivator } from './decorators';
import { IntegrationModule, type IntegrationModuleOptions } from './integration.module';
import type { IntegrationMessage } from './message';
import { CareScope } from './resilience/retry-budget';
import { TraceContext } from './trace/trace-context';
import { waitFor } from './testing/index';

const flaky = (): Error => Object.assign(new Error('flaky'), { retryable: true });

@Injectable()
class Producer {
  constructor(private readonly registry: ChannelRegistry) {}

  @ServiceActivator('budget.in')
  async forward(payload: unknown): Promise<void> {
    await this.registry.send('budget.work', payload);
  }
}

@Injectable()
class Consumer {
  readonly seen: IntegrationMessage[] = [];

  constructor(private readonly registry: ChannelRegistry) {}

  @ServiceActivator('budget.work', {
    care: { tries: { max: 3, idempotent: true, spacing: 0 } },
  })
  async consume(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    this.seen.push(msg);
    if (this.seen.length === 1) await this.registry.send('budget.started', null);
    throw flaky();
  }
}

async function boot(options: Partial<IntegrationModuleOptions>) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot({
        channels: [
          { name: 'budget.in', type: 'direct' },
          { name: 'budget.work', type: 'queue' },
          { name: 'budget.started', type: 'pubsub' },
        ],
        logging: { banner: false },
        ...options,
      }),
    ],
    providers: [Producer, Consumer],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

/** Sends one message to `budget.in` and waits until the queue consumer has given up. */
async function runOnce(
  moduleRef: Awaited<ReturnType<typeof boot>>,
  headers: Record<string, unknown>,
): Promise<IntegrationMessage[]> {
  const registry = moduleRef.get(ChannelRegistry);
  const consumer = moduleRef.get(Consumer);
  const failed = waitFor(registry, 'error.channel');
  await registry.send('budget.in', { order: 1 }, headers);
  await failed;
  return consumer.seen;
}

describe('ChannelRegistry.send under a tries left scope (RS-29)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('RU-29b a message sent to a queue channel under a tries left scope carries triesLeft and the consumer rebuilds the scope', async () => {
    const moduleRef = await boot({ care: { events: { channel: false } } });
    const seen = await runOnce(moduleRef, { triesLeft: 0, idempotencyKey: 'k-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.triesLeft).toBe(0);
    await moduleRef.close();
  });

  it('RU-29b without an incoming tries left the queue consumer keeps its own extra tries', async () => {
    const moduleRef = await boot({ care: { events: { channel: false } } });
    const seen = await runOnce(moduleRef, { idempotencyKey: 'k-2' });
    expect(seen).toHaveLength(3);
    expect(seen[0]?.headers.triesLeft).toBeUndefined();
    await moduleRef.close();
  });

  it('RU-29b without forRoot({ care }) no message gets a triesLeft header', async () => {
    const moduleRef = await boot({});
    const seen = await runOnce(moduleRef, { triesLeft: 0, idempotencyKey: 'k-3' });
    expect(seen).toHaveLength(3);
    expect(seen[0]?.headers.triesLeft).toBeUndefined();
    await moduleRef.close();
  });

  it('copies the scope tries left only when opted in, and never over an explicit header', async () => {
    const plain = new ChannelRegistry({ trace: new TraceContext() });
    const opted = new ChannelRegistry({ trace: new TraceContext() });
    opted.inheritTriesLeft();
    const received: IntegrationMessage[] = [];
    for (const registry of [plain, opted]) {
      registry.create({ name: 'c', type: 'direct' }).subscribe((msg) => {
        received.push(msg);
      });
    }
    await CareScope.run({ triesLeft: 0 }, async () => {
      await plain.send('c', 1);
      await opted.send('c', 2);
      await opted.send('c', 3, { triesLeft: 2 });
    });
    await opted.send('c', 4);
    expect(received.map((msg) => [msg.payload, msg.headers.triesLeft])).toEqual([
      [1, undefined],
      [2, 0],
      [3, 2],
      [4, undefined],
    ]);
  });
});
