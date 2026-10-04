import 'reflect-metadata';

import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpException,
  Injectable,
  Module,
  NotFoundException,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ServiceActivator } from '../src/decorators';
import { IntegrationFlow, type FlowDefinition } from '../src/flow/integration-flow';
import { MemoryIdempotencyStore } from '../src/idempotency/memory-idempotency.store';
import { InboundRest } from '../src/inbound/inbound.decorators';
import { markInboundFailure } from '../src/inbound/inbound.failure';
import type {
  InboundFailureAction,
  InboundFailureClassifier,
  InboundKey,
  InboundKeyContext,
  InboundKeyResolver,
  InboundReplyContext,
  InboundReplyMapper,
} from '../src/inbound/inbound.types';
import { IntegrationModule } from '../src/integration.module';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface OpenAccount {
  tenant: string;
  name: string;
  mode?: 'ok' | 'slow' | 'invalid' | 'partial' | 'unmarked';
}

@Injectable()
class TenantDirectory {
  private readonly known = new Set(['acme', 'globex']);
  has(tenant: string): boolean {
    return this.known.has(tenant);
  }
}

/** Service-owned response contract: `{ data, success }`, resolved from DI. */
@Injectable()
class DataReplyMapper implements InboundReplyMapper<OpenAccount> {
  mapReply(ctx: InboundReplyContext<OpenAccount>): unknown {
    return { data: ctx.result, success: true, tenant: ctx.payload.tenant };
  }
}

/** Tenant-bound key; validates before the claim using an injected service. */
@Injectable()
class TenantKeyResolver implements InboundKeyResolver<OpenAccount> {
  constructor(private readonly tenants: TenantDirectory) {}

  resolveKey({ payload, clientKey }: InboundKeyContext<OpenAccount>): InboundKey | undefined {
    if (!this.tenants.has(payload.tenant)) throw new NotFoundException('TENANT_NOT_FOUND');
    if (clientKey === undefined) return undefined;
    return { scope: 'acct-open', key: [payload.tenant, clientKey] };
  }
}

@Injectable()
class SharedStore extends MemoryIdempotencyStore {}

@Injectable()
class RecordingClassifier implements InboundFailureClassifier {
  readonly seen: unknown[] = [];
  classify(error: unknown): InboundFailureAction {
    this.seen.push(error);
    return 'release';
  }
}

@Injectable()
class AccountsActivator {
  executions = 0;
  readonly thrown: unknown[] = [];

  @ServiceActivator('acct.open')
  async open(payload: OpenAccount & { viaFlow?: boolean }): Promise<unknown> {
    this.executions += 1;
    if (payload.mode === 'slow') await delay(150);
    if (payload.mode === 'invalid') {
      throw this.remember(markInboundFailure(new BadRequestException('INVALID_NAME'), 'release'));
    }
    if (payload.mode === 'partial') {
      const body = { statusCode: 422, message: 'PARTIALLY_COMMITTED', committedLevels: 1 };
      throw this.remember(markInboundFailure(new HttpException(body, 422), 'store'));
    }
    if (payload.mode === 'unmarked') throw this.remember(new BadRequestException('UNMARKED'));
    return {
      accountId: `${payload.tenant}-${payload.name}`,
      execution: this.executions,
      viaFlow: payload.viaFlow === true,
    };
  }

  private remember<E>(error: E): E {
    this.thrown.push(error);
    return error;
  }
}

@Controller('accounts')
class AccountsController {
  /** Inherits every module-wide inbound default. The request body is the flow payload. */
  @Post()
  @InboundRest({ channel: 'acct.in', requestReply: true, timeoutMs: 2_000 })
  open(): void {}

  /** Overrides the failure policy with a DI classifier; the rest is inherited. */
  @Post('classified')
  @InboundRest({
    channel: 'acct.in',
    requestReply: true,
    timeoutMs: 2_000,
    idempotency: { onFailure: { useExisting: RecordingClassifier } },
  })
  classified(): void {}

  /** Shorter than the slow activator: the flow outlives the reply timeout. */
  @Post('impatient')
  @InboundRest({
    channel: 'acct.in',
    requestReply: true,
    timeoutMs: 30,
    idempotency: { onFailure: 'release' },
  })
  impatient(): void {}

  /** Opts back into the estela defaults. */
  @Post('plain')
  @InboundRest({
    channel: 'acct.in',
    requestReply: true,
    timeoutMs: 2_000,
    reply: 'envelope',
    idempotency: false,
  })
  plain(): void {}
}

const OpenAccountFlow: FlowDefinition = {
  name: 'open-account',
  build: () =>
    IntegrationFlow.from('acct.in')
      .transform((payload) => ({ ...(payload as OpenAccount), viaFlow: true }))
      .to('acct.open'),
};

@Module({
  imports: [
    IntegrationModule.forRoot(
      {
        channels: [
          { name: 'acct.in', type: 'direct' },
          { name: 'acct.open', type: 'direct' },
        ],
        inbound: {
          reply: { useExisting: DataReplyMapper },
          idempotency: {
            store: { useExisting: SharedStore },
            key: { useExisting: TenantKeyResolver },
            onDuplicate: 'replay',
            onInFlight: () => new ConflictException('IDEMPOTENCY_KEY_IN_PROGRESS'),
            onFailure: 'marker',
          },
        },
      },
      [OpenAccountFlow],
    ),
  ],
  controllers: [AccountsController],
  providers: [
    TenantDirectory,
    DataReplyMapper,
    TenantKeyResolver,
    SharedStore,
    RecordingClassifier,
    AccountsActivator,
  ],
})
class AccountsModule {}

describe('adaptable inbound over real Nest HTTP (0.6.0)', () => {
  let app: INestApplication | undefined;
  let url: string;
  let activator: AccountsActivator;
  let classifier: RecordingClassifier;
  let store: SharedStore;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AccountsModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    activator = moduleRef.get(AccountsActivator);
    classifier = moduleRef.get(RecordingClassifier);
    store = moduleRef.get(SharedStore);
  }, 20_000);

  afterAll(async () => {
    await app?.close();
  });

  const post = async (
    path: string,
    body: unknown,
    key?: string,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key !== undefined ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  it('module-wide DI mapper, resolver and store; a repeat is a byte-identical replay', async () => {
    const before = activator.executions;
    const first = await post('/accounts', { tenant: 'acme', name: 'main' }, 'k-1');
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      data: { accountId: 'acme-main', execution: before + 1, viaFlow: true },
      success: true,
      tenant: 'acme',
    });
    const second = await post('/accounts', { tenant: 'acme', name: 'main' }, 'k-1');
    expect(second).toEqual(first);
    expect(activator.executions).toBe(before + 1);
    expect((await store.get('acct-open', 'acme:k-1'))?.status).toBe('completed');
  }, 20_000);

  it('the same key from another tenant executes on its own (no cross-tenant replay)', async () => {
    const acme = await post('/accounts', { tenant: 'acme', name: 'shared' }, 'k-2');
    const globex = await post('/accounts', { tenant: 'globex', name: 'shared' }, 'k-2');
    expect((acme.body as { data: { accountId: string } }).data.accountId).toBe('acme-shared');
    expect((globex.body as { data: { accountId: string } }).data.accountId).toBe('globex-shared');
  }, 20_000);

  it('resolver validation runs before the claim: nothing is stored for a rejected request', async () => {
    const before = activator.executions;
    const response = await post('/accounts', { tenant: 'unknown', name: 'x' }, 'k-3');
    expect(response.status).toBe(404);
    expect(activator.executions).toBe(before);
    expect(await store.get('acct-open', 'unknown:k-3')).toBeUndefined();
  }, 20_000);

  it('a repeat while the first is in flight answers 409', async () => {
    const first = post('/accounts', { tenant: 'acme', name: 'slow', mode: 'slow' }, 'k-4');
    await delay(40);
    const second = await post('/accounts', { tenant: 'acme', name: 'slow', mode: 'slow' }, 'k-4');
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ message: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
    expect((await first).status).toBe(201);
  }, 20_000);

  it('an error marked inside the activator of a real flow releases the key', async () => {
    const before = activator.executions;
    const failed = await post('/accounts', { tenant: 'acme', name: 'bad', mode: 'invalid' }, 'k-5');
    expect(failed.status).toBe(400);
    expect(await store.get('acct-open', 'acme:k-5')).toBeUndefined();
    const retried = await post('/accounts', { tenant: 'acme', name: 'good' }, 'k-5');
    expect(retried.status).toBe(201);
    expect(activator.executions).toBe(before + 2);
  }, 20_000);

  it('a marked partial failure is stored and replayed as the same HTTP error', async () => {
    const before = activator.executions;
    const failed = await post(
      '/accounts',
      { tenant: 'acme', name: 'half', mode: 'partial' },
      'k-6',
    );
    expect(failed.status).toBe(422);
    expect(failed.body).toEqual({
      statusCode: 422,
      message: 'PARTIALLY_COMMITTED',
      committedLevels: 1,
    });
    const replayed = await post(
      '/accounts',
      { tenant: 'acme', name: 'half', mode: 'partial' },
      'k-6',
    );
    expect(replayed).toEqual(failed);
    expect(activator.executions).toBe(before + 1);
  }, 20_000);

  it('an unmarked failure keeps the key blocked under the marker policy', async () => {
    const failed = await post('/accounts', { tenant: 'acme', name: 'u', mode: 'unmarked' }, 'k-7');
    expect(failed.status).toBe(400);
    expect((await store.get('acct-open', 'acme:k-7'))?.status).toBe('failed');
  }, 20_000);

  it('the error thrown in the activator reaches the interceptor as the same instance', async () => {
    const failed = await post(
      '/accounts/classified',
      { tenant: 'acme', name: 'c', mode: 'unmarked' },
      'k-8',
    );
    expect(failed.status).toBe(400);
    expect(classifier.seen).toHaveLength(1);
    expect(classifier.seen[0]).toBe(activator.thrown[activator.thrown.length - 1]);
    expect(await store.get('acct-open', 'acme:k-8')).toBeUndefined();
  }, 20_000);

  it('a flow that outlives the reply timeout runs once: the key is not released', async () => {
    const before = activator.executions;
    const first = await post(
      '/accounts/impatient',
      { tenant: 'acme', name: 'late', mode: 'slow' },
      'k-10',
    );
    const second = await post(
      '/accounts/impatient',
      { tenant: 'acme', name: 'late', mode: 'slow' },
      'k-10',
    );
    expect(first.status).toBe(500);
    // The kept key answers the retry as a duplicate; the activator is not run again.
    expect(second.body).toMatchObject({ data: null });
    expect(activator.executions).toBe(before + 1);
    expect((await store.get('acct-open', 'acme:k-10'))?.status).toBe('failed');
  }, 20_000);

  it('an endpoint can opt back into the estela envelope and no inbound claim', async () => {
    const first = await post('/accounts/plain', { tenant: 'acme', name: 'p' }, 'k-9');
    const second = await post('/accounts/plain', { tenant: 'acme', name: 'p' }, 'k-9');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const executionOf = (response: { body: unknown }): number =>
      (response.body as { result: { execution: number } }).result.execution;
    expect(first.body).toMatchObject({ status: 'ok', result: { accountId: 'acme-p' } });
    expect(executionOf(second)).toBe(executionOf(first) + 1);
  }, 20_000);
});
