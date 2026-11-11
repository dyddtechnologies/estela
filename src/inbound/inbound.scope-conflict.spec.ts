import 'reflect-metadata';

import { Body, Controller, Logger, Post } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { IntegrationModule } from '../integration.module';
import { PrivacyEngine } from '../sensitive/privacy-engine';
import { PrivacyConfigError } from '../sensitive/privacy-errors';
import { Remember } from '../sensitive/privacy.types';
import { InboundRest } from './inbound.decorators';

const profiles = { personal: { fields: ['**.email'] }, audit: { fields: ['**.ssn'] } };

@Controller()
class EverythingApi {
  @Post('orders/a')
  @InboundRest({
    channel: 'orders',
    requestReply: true,
    privacy: { use: 'nope', rememberReason: 'support-reads-orders' },
    idempotency: { remember: Remember.Everything },
  })
  a(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller()
class OutcomeApi {
  @Post('orders/b')
  @InboundRest({
    channel: 'orders',
    requestReply: true,
    privacy: 'personal',
    idempotency: { remember: Remember.OutcomeOnly, onDuplicate: 'envelope' },
  })
  b(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller()
class SameApiOne {
  @Post('orders/one')
  @InboundRest({ channel: 'orders', privacy: { use: ['personal'], fields: ['**.pan'] } })
  one(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller()
class SameApiTwo {
  @Post('orders/two')
  @InboundRest({ channel: 'orders', privacy: { use: ['personal'], fields: ['**.pan'] } })
  two(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller()
class PlainReplayApi {
  @Post('plain/replay')
  @InboundRest({ channel: 'orders', requestReply: true, idempotency: { onDuplicate: 'replay' } })
  replay(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller()
class PlainEventApi {
  @Post('plain/event')
  @InboundRest({ channel: 'orders' })
  event(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller()
class OutcomeEventApi {
  @Post('outcome/event')
  @InboundRest({ channel: 'orders', idempotency: { remember: Remember.OutcomeOnly } })
  event(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller()
class OutcomeReplayApi {
  @Post('outcome/replay')
  @InboundRest({
    channel: 'orders',
    requestReply: true,
    idempotency: { remember: Remember.OutcomeOnly, onDuplicate: 'replay' },
  })
  replay(@Body() body: unknown): unknown {
    return body;
  }
}

async function boot(controllers: unknown[]): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot({
        channels: [{ name: 'orders', type: 'direct' }],
        logging: { banner: false },
        privacy: { profiles },
      }),
    ],
    controllers: controllers as never[],
  }).compile();
  await mod.init();
  return mod;
}

async function bootError(controllers: unknown[]): Promise<unknown> {
  const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  try {
    const mod = await boot(controllers);
    await mod.close();
    return undefined;
  } catch (error) {
    return error;
  } finally {
    spy.mockRestore();
  }
}

describe('6.6 inbound scope per channel (SD-44, SD-64)', () => {
  it('endpoints on one channel with different privacy fail boot naming both handlers', async () => {
    for (const order of [
      [EverythingApi, OutcomeApi],
      [OutcomeApi, EverythingApi],
    ]) {
      const error = await bootError(order);
      expect(error).toBeInstanceOf(PrivacyConfigError);
      const findings = (error as PrivacyConfigError).findings;
      const conflict = findings.find((f) => f.code === 'INBOUND_SCOPE_CONFLICT');
      expect(conflict).toMatchObject({ severity: 'error', subject: "inbound 'orders'" });
      expect((error as Error).message).toContain('EverythingApi.a');
      expect((error as Error).message).toContain('OutcomeApi.b');
    }
  });

  it('compat: endpoints on one channel without privacy boot as before, replay or not', async () => {
    const mod = await boot([PlainReplayApi, PlainEventApi]);
    expect(mod.get(PrivacyEngine).hasScope('inbound:orders')).toBe(true);
    await mod.close();
  });

  it('a replaying endpoint later on the channel still gets OUTCOME_ONLY_REPLAY (SD-30)', async () => {
    const error = await bootError([OutcomeEventApi, OutcomeReplayApi]);
    expect(error).toBeInstanceOf(PrivacyConfigError);
    expect((error as PrivacyConfigError).findings.map((f) => f.code)).toEqual([
      'OUTCOME_ONLY_REPLAY',
    ]);
  });

  it('endpoints on one channel with the same privacy share the scope and boot', async () => {
    const mod = await boot([SameApiOne, SameApiTwo]);
    expect(mod.get(PrivacyEngine).hasScope('inbound:orders')).toBe(true);
    await mod.close();
  });
});
