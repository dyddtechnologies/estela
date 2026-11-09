import { LruMap } from './lru';
import type { BreakerPlan } from './resilience.plan';
import type { ResilienceClock } from './resilience.types';
import type { StateSwitch } from './state-port';

export type BreakerState = 'closed' | 'open' | 'half-open';
export type BreakerTransition =
  'breaker.open' | 'breaker.half-open' | 'breaker.closed' | 'breaker.forced-open';

/** A shared manual opening lasts until reset; the marker needs a finite expiry. */
const MANUAL_MARKER_MS = 2_147_483_647;

interface Outcome {
  at: number;
  failure: boolean;
}

interface Entry {
  state: BreakerState;
  /** Monotonic time the open state ends; Infinity for a manual quota opening. */
  openUntil: number;
  forcedBy?: 'quota';
  probes: number;
  probeSuccesses: number;
  outcomes: Outcome[];
  /** Shared marker cache (RS-23). */
  checkedAt: number;
  sharedUntil?: number;
  sharedQuota: boolean;
  sharedSeen: boolean;
}

export interface Admission {
  key: string;
  entry?: Entry;
  probe: boolean;
}

export type AdmitResult =
  | { admitted: true; admission: Admission }
  | { admitted: false; retryAfterMs?: number; forcedBy?: 'quota' };

export interface BreakerHooks {
  transition(type: BreakerTransition, key: string): void;
  capacity(key: string): void;
}

export interface SharedBreakerState {
  switch: StateSwitch;
  stateKey(key: string): string;
}

function newEntry(): Entry {
  return {
    state: 'closed',
    openUntil: 0,
    probes: 0,
    probeSuccesses: 0,
    outcomes: [],
    checkedAt: -Infinity,
    sharedQuota: false,
    sharedSeen: false,
  };
}

/**
 * Circuit breakers of one policy, per key (RS-18 to RS-20): closed, open and half-open states,
 * a count or time window of recorded attempts, quota openings (RS-16) and an optional shared open
 * marker plus probe lease (RS-23). Breakers live in an LRU bounded by `maxKeys`; only closed ones
 * are evicted (I11).
 */
export class CircuitBreakers {
  private readonly entries = new LruMap<Entry>();

  constructor(
    private readonly plan: BreakerPlan,
    private readonly clock: ResilienceClock,
    private readonly hooks: BreakerHooks,
    private readonly shared?: SharedBreakerState,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get openCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.state !== 'closed') count += 1;
    return count;
  }

  async admit(key: string, deadlineAt: number): Promise<AdmitResult> {
    const entry = this.entryFor(key);
    if (entry === undefined) return { admitted: true, admission: { key, probe: false } };
    this.maybeHalfOpen(key, entry);
    if (entry.state === 'open') return this.rejected(entry);
    if (entry.state === 'half-open') return this.admitProbe(key, entry);
    if (this.shared !== undefined) {
      const sharedResult = await this.checkShared(key, entry, deadlineAt);
      if (sharedResult !== undefined) return sharedResult;
    }
    return { admitted: true, admission: { key, entry, probe: false } };
  }

  success(admission: Admission): void {
    const entry = admission.entry;
    if (entry === undefined) return;
    if (!admission.probe) {
      this.record(entry, false);
      return;
    }
    entry.probes -= 1;
    entry.probeSuccesses += 1;
    if (entry.state === 'half-open' && entry.probeSuccesses >= this.plan.halfOpenCalls) {
      this.close(admission.key, entry);
    }
  }

  failure(admission: Admission): void {
    const entry = admission.entry;
    if (entry === undefined) return;
    if (admission.probe) {
      entry.probes -= 1;
      this.open(admission.key, entry, this.plan.openMs, 'breaker.open');
      return;
    }
    if (entry.state !== 'closed') return;
    this.record(entry, true);
    if (this.tripped(entry)) this.open(admission.key, entry, this.plan.openMs, 'breaker.open');
  }

  /** Frees a probe slot without changing the state (not recorded, rate limited, cut). */
  release(admission: Admission): void {
    if (admission.probe && admission.entry !== undefined) admission.entry.probes -= 1;
  }

  /** RS-16: a quota failure forces the breaker of its key open, even below minimumCalls. */
  forceOpen(admission: Admission): void {
    const entry = admission.entry ?? this.entries.peek(admission.key);
    if (admission.probe && entry !== undefined) entry.probes -= 1;
    if (entry === undefined) return;
    if (entry.state === 'open' && entry.forcedBy === 'quota') return;
    const ms = this.plan.quotaOpenMs;
    entry.forcedBy = 'quota';
    this.open(admission.key, entry, ms === 'manual' ? Infinity : ms, 'breaker.forced-open');
  }

  stateOf(key: string): { state: BreakerState; forcedBy?: 'quota' } | undefined {
    const entry = this.entries.peek(key);
    if (entry === undefined) return undefined;
    this.maybeHalfOpen(key, entry);
    return entry.forcedBy === undefined
      ? { state: entry.state }
      : { state: entry.state, forcedBy: entry.forcedBy };
  }

  /** RS-49: closes the local breaker and clears the shared markers. */
  async reset(key: string): Promise<boolean> {
    const entry = this.entries.peek(key);
    if (this.shared !== undefined) {
      const stateKey = this.shared.stateKey(key);
      const port = this.plan.state;
      await this.shared.switch.call(
        () => Promise.all([port?.clearOpen(stateKey), port?.clearOpen(`${stateKey}:quota`)]),
        Infinity,
      );
    }
    if (entry === undefined) return false;
    this.close(key, entry);
    return true;
  }

  private entryFor(key: string): Entry | undefined {
    const found = this.entries.get(key);
    if (found !== undefined) return found;
    if (this.entries.size >= this.plan.maxKeys) {
      const evicted = this.entries.evictOne(
        (entry) => entry.state === 'closed' && entry.probes === 0,
      );
      if (!evicted) {
        this.hooks.capacity(key);
        return undefined;
      }
    }
    const entry = newEntry();
    this.entries.set(key, entry);
    return entry;
  }

  private maybeHalfOpen(key: string, entry: Entry): void {
    if (entry.state !== 'open' || this.clock.monotonic() < entry.openUntil) return;
    entry.state = 'half-open';
    entry.probes = 0;
    entry.probeSuccesses = 0;
    this.hooks.transition('breaker.half-open', key);
  }

  private rejected(entry: Entry): AdmitResult {
    const remaining = entry.openUntil - this.clock.monotonic();
    const result: AdmitResult = { admitted: false };
    if (Number.isFinite(remaining)) result.retryAfterMs = Math.max(0, Math.ceil(remaining));
    if (entry.forcedBy !== undefined) result.forcedBy = entry.forcedBy;
    return result;
  }

  private admitProbe(key: string, entry: Entry): AdmitResult {
    if (entry.probes >= this.plan.halfOpenCalls) return { admitted: false };
    entry.probes += 1;
    return { admitted: true, admission: { key, entry, probe: true } };
  }

  /** Reads the shared marker at most once per `syncMs` (RS-23); undefined = admit as closed. */
  private async checkShared(
    key: string,
    entry: Entry,
    deadlineAt: number,
  ): Promise<AdmitResult | undefined> {
    const shared = this.shared!;
    const now = this.clock.monotonic();
    if (now - entry.checkedAt >= this.plan.syncMs) {
      entry.checkedAt = now;
      const stateKey = shared.stateKey(key);
      const port = this.plan.state!;
      const answer = await shared.switch.call(
        () => Promise.all([port.openUntil(stateKey), port.openUntil(`${stateKey}:quota`)]),
        deadlineAt,
      );
      if (answer !== undefined) {
        const [plain, quota] = answer.value;
        const until = Math.max(plain ?? -Infinity, quota ?? -Infinity);
        if (Number.isFinite(until)) {
          entry.sharedUntil = until;
          entry.sharedQuota = quota !== undefined && quota >= (plain ?? -Infinity);
          entry.sharedSeen = true;
        }
      }
    }
    if (!entry.sharedSeen || entry.sharedUntil === undefined) return undefined;
    const remaining = entry.sharedUntil - this.clock.wall();
    if (remaining > 0) {
      const result: AdmitResult = { admitted: false, retryAfterMs: Math.ceil(remaining) };
      if (entry.sharedQuota) result.forcedBy = 'quota';
      return result;
    }
    return this.sharedProbe(key, entry, deadlineAt);
  }

  /** A pod that saw a marker probes after it expires, only while it holds the lease. */
  private async sharedProbe(key: string, entry: Entry, deadlineAt: number): Promise<AdmitResult> {
    const shared = this.shared!;
    const port = this.plan.state!;
    const stateKey = shared.stateKey(key);
    const lease = await shared.switch.call(
      () => port.tryProbeLease(stateKey, this.plan.openMs),
      deadlineAt,
    );
    // Degraded state: decide locally, the marker read earlier has expired.
    if (lease !== undefined && !lease.value) return { admitted: false };
    entry.sharedSeen = false;
    entry.state = 'half-open';
    entry.probes = 1;
    entry.probeSuccesses = 0;
    return { admitted: true, admission: { key, entry, probe: true } };
  }

  private record(entry: Entry, failure: boolean): void {
    const now = this.clock.monotonic();
    entry.outcomes.push({ at: now, failure });
    const window = this.plan.window;
    if (window.type === 'count') {
      if (entry.outcomes.length > window.size)
        entry.outcomes.splice(0, entry.outcomes.length - window.size);
      return;
    }
    const from = now - window.sizeMs;
    const firstKept = entry.outcomes.findIndex((outcome) => outcome.at > from);
    entry.outcomes.splice(0, firstKept === -1 ? entry.outcomes.length : firstKept);
  }

  private tripped(entry: Entry): boolean {
    const recorded = entry.outcomes.length;
    if (recorded < this.plan.minimumCalls) return false;
    const failures = entry.outcomes.filter((outcome) => outcome.failure).length;
    return (failures * 100) / recorded >= this.plan.failureRateThreshold;
  }

  private open(key: string, entry: Entry, ms: number, type: BreakerTransition): void {
    entry.state = 'open';
    entry.openUntil = this.clock.monotonic() + ms;
    entry.outcomes = [];
    entry.probeSuccesses = 0;
    if (type === 'breaker.open') delete entry.forcedBy;
    this.hooks.transition(type, key);
    this.writeMarker(key, ms, type === 'breaker.forced-open');
  }

  private close(key: string, entry: Entry): void {
    const wasClosed = entry.state === 'closed' && entry.forcedBy === undefined;
    entry.state = 'closed';
    entry.openUntil = 0;
    entry.outcomes = [];
    entry.probes = 0;
    entry.probeSuccesses = 0;
    entry.sharedSeen = false;
    delete entry.sharedUntil;
    delete entry.forcedBy;
    if (!wasClosed) this.hooks.transition('breaker.closed', key);
  }

  /** One write per transition; failures degrade through the switch, never the call. */
  private writeMarker(key: string, ms: number, quota: boolean): void {
    if (this.shared === undefined) return;
    const port = this.plan.state!;
    const stateKey = quota ? `${this.shared.stateKey(key)}:quota` : this.shared.stateKey(key);
    const until = this.clock.wall() + (Number.isFinite(ms) ? ms : MANUAL_MARKER_MS);
    void this.shared.switch.call(() => port.markOpen(stateKey, until), Infinity);
  }
}
