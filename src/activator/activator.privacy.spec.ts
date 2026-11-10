import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Injectable, Logger } from '@nestjs/common';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import { ChannelRegistry } from '../channel-registry';
import { ServiceActivator } from '../decorators';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import type { IntegrationMessage } from '../message';
import { Remember } from '../sensitive/privacy.types';
import { SealKeyUnavailableError } from '../sensitive/privacy-errors';
import { OUTCOME_ONLY_RECORD_KEY, SEALED_RECORD_KEY } from '../sensitive/sealed-record';
import type { SealKey, SealKeyProvider } from '../sensitive/seal-key';
import { captureTrail } from '../testing/capture-trail';
import { expectNoLeak } from '../testing/expect-no-leak';

const TOKEN = 'CANARYTOKEN0001';
const SCOPE = 'activator:Vault.read';

@Injectable()
class Vault {
  calls = 0;

  @ServiceActivator('vault.read')
  read(): { token: string; ok: boolean } {
    this.calls++;
    return { token: TOKEN, ok: true };
  }
}

@Injectable()
class SealedVault {
  calls = 0;

  @ServiceActivator('vault.read', { privacy: { remember: Remember.Sealed } })
  read(): { token: string } {
    this.calls++;
    return { token: TOKEN };
  }
}

function sealKeys(): SealKeyProvider & { down: boolean } {
  const key: SealKey = { id: 'k1', key: randomBytes(32) };
  const provider = {
    down: false,
    current: (): Promise<SealKey> =>
      provider.down ? Promise.reject(new Error('kms down')) : Promise.resolve(key),
    byId: (id: string): Promise<SealKey | undefined> =>
      Promise.resolve(id === key.id ? key : undefined),
  };
  return provider;
}

async function boot(
  activator: new (...args: never[]) => unknown,
  options: Partial<IntegrationModuleOptions>,
): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot({
        channels: [
          { name: 'vault.read', type: 'direct' },
          { name: 'vault.reply', type: 'pubsub' },
        ],
        ...options,
      }),
    ],
    providers: [activator],
  }).compile();
  await mod.init();
  return mod;
}

function replies(mod: TestingModule): IntegrationMessage[] {
  const seen: IntegrationMessage[] = [];
  mod
    .get(ChannelRegistry)
    .get('vault.reply')
    .subscribe((msg) => {
      seen.push(msg);
    });
  return seen;
}

const send = (mod: TestingModule): Promise<void> =>
  mod
    .get(ChannelRegistry)
    .send('vault.read', {}, { idempotencyKey: 'k-1', replyChannel: 'vault.reply' });

function warnLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation((m: unknown) => lines.push(String(m)) as never);
  return { lines, restore: () => spy.mockRestore() };
}

describe('S7 activator records (SD-29, SD-34, 8.2)', () => {
  it('remember default: Everything without privacy, OutcomeOnly with one, defaulted scopes listed at boot', async () => {
    const plainStore = new MemoryIdempotencyStore();
    const plain = await boot(Vault, { idempotency: { store: plainStore } });
    await send(plain);
    expect((await plainStore.get(SCOPE, 'k-1'))?.result).toEqual({
      cachedResult: { token: TOKEN, ok: true },
    });
    await plain.close();

    const store = new MemoryIdempotencyStore();
    const { lines, restore } = warnLines();
    const mod = await boot(Vault, {
      idempotency: { store },
      privacy: { fields: ['**.pan'] },
    });
    restore();
    expect(lines.filter((l) => l.includes(`'${SCOPE}': remember defaulted`))).toHaveLength(1);
    await send(mod);
    expect((await store.get(SCOPE, 'k-1'))?.result).toEqual({
      [OUTCOME_ONLY_RECORD_KEY]: { v: 1 },
    });
    await mod.close();
  });

  it('activator duplicate on an outcome-only record warns and does not reply', async () => {
    const mod = await boot(Vault, { privacy: { fields: ['**.pan'] } });
    const seen = replies(mod);
    await send(mod);
    const { lines, restore } = warnLines();
    await send(mod);
    restore();
    expect(seen).toHaveLength(1);
    const warn = lines.filter((l) => l.includes('outcome-only record'));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain(SCOPE);
    expect(warn[0]).not.toContain('k-1');
    expect(mod.get(Vault).calls).toBe(1);
    await mod.close();
  });

  it('matrix AsShown: the record and the re-sent duplicate are hidden', async () => {
    const capture = captureTrail();
    const store = new MemoryIdempotencyStore();
    const mod = await boot(Vault, {
      idempotency: { store: capture.store(store) },
      privacy: { remember: Remember.AsShown },
    });
    const seen = replies(mod);
    await send(mod);
    await send(mod);
    expect(seen[0]?.payload).toEqual({ token: TOKEN, ok: true });
    expect(seen[1]?.payload).toEqual({ token: '[HIDDEN:secrets.keys]', ok: true });
    expectNoLeak(capture, [TOKEN]);
    await mod.close();
  });

  it('matrix Sealed: the record is sealed and a duplicate decrypts and re-sends it', async () => {
    const capture = captureTrail();
    const store = new MemoryIdempotencyStore();
    const keys = sealKeys();
    const mod = await boot(SealedVault, {
      idempotency: { store: capture.store(store) },
      privacy: { sealKeys: keys },
    });
    const seen = replies(mod);
    await send(mod);
    await send(mod);
    expect((await store.get(SCOPE.replace('Vault', 'SealedVault'), 'k-1'))?.result).toHaveProperty(
      SEALED_RECORD_KEY,
    );
    expect(seen.map((m) => m.payload)).toEqual([{ token: TOKEN }, { token: TOKEN }]);
    expect(mod.get(SealedVault).calls).toBe(1);
    expectNoLeak(capture, [TOKEN]);
    await mod.close();
  });

  it('seal key provider down at claim fails closed before dispatch', async () => {
    const store = new MemoryIdempotencyStore();
    const keys = sealKeys();
    const mod = await boot(SealedVault, { idempotency: { store }, privacy: { sealKeys: keys } });
    keys.down = true;
    const error = await send(mod).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SealKeyUnavailableError);
    expect((error as SealKeyUnavailableError).retryable).toBe(true);
    expect(mod.get(SealedVault).calls).toBe(0);
    expect(await store.get('activator:SealedVault.read', 'k-1')).toBeUndefined();
    await mod.close();
  });
});
