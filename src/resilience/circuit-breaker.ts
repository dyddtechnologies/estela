import { LruMap } from './lru';
import type { ValvePlan } from './resilience.plan';
import type { CareClock } from './resilience.types';
import type { StateSwitch } from './state-port';

export type BreakerState = 'flowing' | 'shut' | 'probing';
export type BreakerTransition =
  'valve.shut' | 'valve.probing' | 'valve.flowing' | 'valve.forced-shut';

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
  /** This pod holds the shared half-open probe lease of the current half-open period. */
  leaseHeld: boolean;
  /** Wall-clock end of the shared mark this pod wrote for its current opening, once stored. */
  markedUntil?: number;
}

export interface Admission {
  key: string;
  entry?: Entry;
  probe: boolean;
}

export type AdmitResult =
  | { admitted: true; admission: Admission }
  | { admitted: false; readyInMs?: number; forcedBy?: 'quota' };

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
    state: 'flowing',
    openUntil: 0,
    probes: 0,
    probeSuccesses: 0,
    outcomes: [],
    checkedAt: -Infinity,
    sharedQuota: false,
    sharedSeen: false,
    leaseHeld: false,
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
    private readonly plan: ValvePlan,
    private readonly clock: CareClock,
    private readonly hooks: BreakerHooks,
    private readonly shared?: SharedBreakerState,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get openCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.state !== 'flowing') count += 1;
    return count;
  }

  async admit(key: string, deadlineAt: number): Promise<AdmitResult> {
    const entry = this.entryFor(key);
    if (entry === undefined) return { admitted: true, admission: { key, probe: false } };
    this.maybeHalfOpen(key, entry);
    if (entry.state === 'shut') {
      if (!(await this.resumedElsewhere(entry, deadlineAt, key))) return this.rejected(entry);
      this.close(key, entry);
    }
    if (entry.state === 'probing') return this.admitProbe(key, entry, deadlineAt);
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
    if (entry.state === 'probing' && entry.probeSuccesses >= this.plan.probes) {
      this.close(admission.key, entry);
    }
  }

  failure(admission: Admission): void {
    const entry = admission.entry;
    if (entry === undefined) return;
    if (admission.probe) {
      entry.probes -= 1;
      this.open(admission.key, entry, this.plan.shutMs, 'valve.shut');
      return;
    }
    if (entry.state !== 'flowing') return;
    this.record(entry, true);
    if (this.tripped(entry)) this.open(admission.key, entry, this.plan.shutMs, 'valve.shut');
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
    if (entry.state === 'shut' && entry.forcedBy === 'quota') return;
    const ms = this.plan.quotaShutMs;
    entry.forcedBy = 'quota';
    this.open(admission.key, entry, ms === 'until-resumed' ? Infinity : ms, 'valve.forced-shut');
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
        () => Promise.all([port?.clearShut(stateKey), port?.clearShut(`${stateKey}:quota`)]),
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
        (entry) => entry.state === 'flowing' && entry.probes === 0,
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
    if (entry.state !== 'shut' || this.clock.monotonic() < entry.openUntil) return;
    entry.state = 'probing';
    entry.probes = 0;
    entry.probeSuccesses = 0;
    entry.leaseHeld = false;
    this.hooks.transition('valve.probing', key);
  }

  private rejected(entry: Entry): AdmitResult {
    const remaining = entry.openUntil - this.clock.monotonic();
    const result: AdmitResult = { admitted: false };
    if (Number.isFinite(remaining)) result.readyInMs = Math.max(0, Math.ceil(remaining));
    if (entry.forcedBy !== undefined) result.forcedBy = entry.forcedBy;
    return result;
  }

  /**
   * With shared state, the pod that opened the breaker probes only while it holds the lease too,
   * so one pod probes per half-open period (RS-23). The slot is reserved while the lease is asked.
   */
  private async admitProbe(key: string, entry: Entry, deadlineAt: number): Promise<AdmitResult> {
    if (entry.probes >= this.plan.probes) return { admitted: false };
    entry.probes += 1;
    if (this.shared !== undefined && !entry.leaseHeld) {
      if (!(await this.takeLease(key, deadlineAt))) {
        entry.probes -= 1;
        return { admitted: false };
      }
      entry.leaseHeld = true;
    }
    return { admitted: true, admission: { key, entry, probe: true } };
  }

  /** True when the lease was granted, or when degraded state leaves the decision local. */
  private async takeLease(key: string, deadlineAt: number): Promise<boolean> {
    const port = this.plan.state!;
    const stateKey = this.shared!.stateKey(key);
    const lease = await this.shared!.switch.call(
      () => port.claimProbe(stateKey, this.plan.shutMs),
      deadlineAt,
    );
    return lease === undefined || lease.value;
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
        () => Promise.all([port.shutUntil(stateKey), port.shutUntil(`${stateKey}:quota`)]),
        deadlineAt,
      );
      if (answer !== undefined) {
        const [plain, quota] = answer.value;
        const until = Math.max(plain ?? -Infinity, quota ?? -Infinity);
        if (Number.isFinite(until)) {
          entry.sharedUntil = until;
          entry.sharedQuota = quota !== undefined && quota >= (plain ?? -Infinity);
          entry.sharedSeen = true;
        } else {
          this.forgetClearedMark(entry);
        }
      }
    }
    if (!entry.sharedSeen || entry.sharedUntil === undefined) return undefined;
    const remaining = entry.sharedUntil - this.clock.wall();
    if (remaining > 0) {
      const result: AdmitResult = { admitted: false, readyInMs: Math.ceil(remaining) };
      if (entry.sharedQuota) result.forcedBy = 'quota';
      return result;
    }
    return this.sharedProbe(key, entry, deadlineAt);
  }

  /**
   * A mark gone before its end was cleared by a resume on another pod (RS-49), not expired:
   * forget it instead of rejecting until the cached end.
   */
  private forgetClearedMark(entry: Entry): void {
    if (!entry.sharedSeen || (entry.sharedUntil ?? -Infinity) <= this.clock.wall()) return;
    entry.sharedSeen = false;
    entry.sharedQuota = false;
    delete entry.sharedUntil;
  }

  /**
   * RS-49 across pods: a pod shut by its own mark reads the shared marks once per `syncMs`; when
   * the mark it stored is gone before its end, another pod resumed the valve. A mark that was
   * never stored (degraded state) proves nothing, so the local opening stands.
   */
  private async resumedElsewhere(entry: Entry, deadlineAt: number, key: string): Promise<boolean> {
    const markedUntil = entry.markedUntil;
    if (this.shared === undefined || markedUntil === undefined) return false;
    const now = this.clock.monotonic();
    if (now - entry.checkedAt < this.plan.syncMs) return false;
    entry.checkedAt = now;
    const stateKey = this.shared.stateKey(key);
    const port = this.plan.state!;
    const answer = await this.shared.switch.call(
      () => Promise.all([port.shutUntil(stateKey), port.shutUntil(`${stateKey}:quota`)]),
      deadlineAt,
    );
    if (answer === undefined) return false;
    const [plain, quota] = answer.value;
    return plain === undefined && quota === undefined && this.clock.wall() < markedUntil;
  }

  /** A pod that saw a marker probes after it expires, only while it holds the lease. */
  private async sharedProbe(key: string, entry: Entry, deadlineAt: number): Promise<AdmitResult> {
    // Degraded state: decide locally, the marker read earlier has expired.
    if (!(await this.takeLease(key, deadlineAt))) return { admitted: false };
    entry.sharedSeen = false;
    entry.state = 'probing';
    entry.probes = 1;
    entry.probeSuccesses = 0;
    entry.leaseHeld = true;
    return { admitted: true, admission: { key, entry, probe: true } };
  }

  private record(entry: Entry, failure: boolean): void {
    const now = this.clock.monotonic();
    entry.outcomes.push({ at: now, failure });
    const lookBack = this.plan.lookBack;
    if ('lastCalls' in lookBack) {
      if (entry.outcomes.length > lookBack.lastCalls)
        entry.outcomes.splice(0, entry.outcomes.length - lookBack.lastCalls);
      return;
    }
    const from = now - lookBack.lastMs;
    const firstKept = entry.outcomes.findIndex((outcome) => outcome.at > from);
    entry.outcomes.splice(0, firstKept === -1 ? entry.outcomes.length : firstKept);
  }

  private tripped(entry: Entry): boolean {
    const recorded = entry.outcomes.length;
    if (recorded < this.plan.minCalls) return false;
    const failures = entry.outcomes.filter((outcome) => outcome.failure).length;
    return (failures * 100) / recorded >= this.plan.failPercent;
  }

  private open(key: string, entry: Entry, ms: number, type: BreakerTransition): void {
    entry.state = 'shut';
    entry.leaseHeld = false;
    entry.openUntil = this.clock.monotonic() + ms;
    entry.outcomes = [];
    entry.probeSuccesses = 0;
    delete entry.markedUntil;
    if (type === 'valve.shut') delete entry.forcedBy;
    this.hooks.transition(type, key);
    this.writeMarker(key, entry, ms, type === 'valve.forced-shut');
  }

  private close(key: string, entry: Entry): void {
    const wasClosed = entry.state === 'flowing' && entry.forcedBy === undefined;
    entry.state = 'flowing';
    entry.openUntil = 0;
    entry.outcomes = [];
    entry.probes = 0;
    entry.probeSuccesses = 0;
    entry.sharedSeen = false;
    delete entry.sharedUntil;
    delete entry.markedUntil;
    delete entry.forcedBy;
    if (!wasClosed) this.hooks.transition('valve.flowing', key);
  }

  /** One write per transition; failures degrade through the switch, never the call. */
  private writeMarker(key: string, entry: Entry, ms: number, quota: boolean): void {
    if (this.shared === undefined) return;
    const port = this.plan.state!;
    const stateKey = quota ? `${this.shared.stateKey(key)}:quota` : this.shared.stateKey(key);
    const until = this.clock.wall() + (Number.isFinite(ms) ? ms : MANUAL_MARKER_MS);
    const openedUntil = entry.openUntil;
    void this.shared.switch
      .call(() => port.markShut(stateKey, until), Infinity)
      .then((stored) => {
        // Only the opening that wrote it may later read its absence as a remote resume.
        if (stored !== undefined && entry.state === 'shut' && entry.openUntil === openedUntil)
          entry.markedUntil = until;
      });
  }
}
