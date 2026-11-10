import type { LoggerService } from '@nestjs/common';
import type { Unsubscribe } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import type { IdempotencyRecord, IdempotencyStore } from '../idempotency/idempotency-store';
import type { IdempotencyLedger, LedgerClaim } from '../saga/idempotency-ledger';
import { TrailOutput } from '../sensitive/privacy-engine';

/** One write to the trail, as the test captured it. */
export interface TrailWrite {
  output: TrailOutput;
  where: string;
  text: string;
}

export interface TrailCapture {
  readonly writes: readonly TrailWrite[];
  /** Nest LoggerService to pass to Logger.overrideLogger / app.useLogger. */
  readonly logger: LoggerService;
  /** Records what is written to the store. */
  store(inner: IdempotencyStore): IdempotencyStore;
  ledger<Tx>(inner: IdempotencyLedger<Tx>): IdempotencyLedger<Tx>;
  /** Records every message of a channel: error.channel as error envelopes, others as tap copies. */
  channel(registry: ChannelRegistry, name: string): Unsubscribe;
  /** Test-only: also record the values before hiding; expectNoLeak refuses such a capture. */
  readonly keepOriginals: boolean;
}

/** JSON text of anything a sink may write; cycles, bigints, Maps, Sets and errors included. */
export function trailText(value: unknown): string {
  if (typeof value === 'string') return value;
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === 'bigint') return item.toString();
        if (item instanceof Error) {
          return { ...item, name: item.name, message: item.message, stack: item.stack };
        }
        if (item instanceof Map) return Object.fromEntries(item as Map<string, unknown>);
        if (item instanceof Set) return [...(item as Set<unknown>)];
        if (typeof item === 'object' && item !== null) {
          if (seen.has(item)) return '[Circular]';
          seen.add(item);
        }
        return item;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

class Capture implements TrailCapture {
  readonly writes: TrailWrite[] = [];
  readonly logger: LoggerService;

  constructor(readonly keepOriginals: boolean) {
    const line =
      (level: string) =>
      (message: unknown, ...rest: unknown[]): void => {
        const parts = [message, ...rest].map((part) => trailText(part));
        this.writes.push({
          output: TrailOutput.Log,
          where: `logger.${level}`,
          text: parts.join(' '),
        });
      };
    this.logger = {
      log: line('log'),
      error: line('error'),
      warn: line('warn'),
      debug: line('debug'),
      verbose: line('verbose'),
      fatal: line('fatal'),
    };
  }

  record(output: TrailOutput, where: string, value: unknown): void {
    this.writes.push({ output, where, text: trailText(value) });
  }

  store(inner: IdempotencyStore): IdempotencyStore {
    const store: IdempotencyStore = {
      begin: (scope, key, ttlMs) => inner.begin(scope, key, ttlMs),
      complete: async (scope, key, result) => {
        this.record(TrailOutput.Store, `store.complete ${scope}`, result);
        return inner.complete(scope, key, result);
      },
      fail: async (scope, key, error) => {
        this.record(TrailOutput.Store, `store.fail ${scope}`, error);
        return inner.fail(scope, key, error);
      },
      get: (scope, key): Promise<IdempotencyRecord | undefined> => inner.get(scope, key),
      purgeExpired: () => inner.purgeExpired(),
    };
    const release = inner.release?.bind(inner);
    if (release !== undefined) store.release = release;
    return store;
  }

  ledger<Tx>(inner: IdempotencyLedger<Tx>): IdempotencyLedger<Tx> {
    const ledger: IdempotencyLedger<Tx> = {
      claim: (tx, scope, key): Promise<LedgerClaim> => inner.claim(tx, scope, key),
      record: async (tx, scope, key, response) => {
        this.record(TrailOutput.Ledger, `ledger.record ${scope}`, response);
        return inner.record(tx, scope, key, response);
      },
      release: (tx, scope, key) => inner.release(tx, scope, key),
    };
    if (inner.transactional !== undefined) {
      return { ...ledger, transactional: inner.transactional };
    }
    return ledger;
  }

  channel(registry: ChannelRegistry, name: string): Unsubscribe {
    const output = name === 'error.channel' ? TrailOutput.ErrorEnvelope : TrailOutput.WireTap;
    return registry.get(name).subscribe((message) => {
      this.record(output, `channel ${name}`, message);
    });
  }
}

/** A capture of everything Estela writes to the trail during a test (4.9). */
export function captureTrail(options: { keepOriginals?: boolean } = {}): TrailCapture {
  return new Capture(options.keepOriginals === true);
}
