import { CareScope } from './retry-budget';
import type { CareClock, CareEvent, CareLogger, CareMetricsPort } from './resilience.types';

const ONE_MINUTE_MS = 60_000;

export const noopCareLogger: CareLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export interface CareObserverOptions {
  clock: CareClock;
  logger?: CareLogger;
  metrics?: CareMetricsPort;
  onEvent?: (event: CareEvent) => void;
  /** Fire-and-forget publisher of the events channel (RS-40). */
  publish?: (event: CareEvent) => Promise<void>;
}

/**
 * Event, metrics and log fan-out of the engine (RS-40, RS-41, RS-45). Nothing here is awaited on
 * the call path, and sink failures are swallowed with at most one warn line per minute (I7).
 */
export class CareObserver {
  readonly logger: CareLogger;
  private readonly lastWarn = new Map<string, number>();

  constructor(private readonly options: CareObserverOptions) {
    this.logger = options.logger ?? noopCareLogger;
  }

  emit(event: Omit<CareEvent, 'at'>): void {
    if (CareScope.current()?.fromEventsChannel === true) return;
    const full: CareEvent = { ...event, at: this.options.clock.wall() };
    try {
      this.options.onEvent?.(full);
    } catch {
      this.warnOnce('events', 'care event hook failed');
    }
    const publish = this.options.publish;
    if (publish === undefined) return;
    const warn = (): void => this.warnOnce('events', 'care events channel publish failed');
    Promise.resolve()
      .then(() => publish(full))
      .catch(warn);
  }

  counter(name: string, labels: Record<string, string>, value = 1): void {
    this.metric(() => this.options.metrics?.counter(name, labels, value));
  }

  histogram(name: string, labels: Record<string, string>, value: number): void {
    this.metric(() => this.options.metrics?.histogram(name, labels, value));
  }

  gauge(name: string, labels: Record<string, string>, value: number): void {
    this.metric(() => this.options.metrics?.gauge(name, labels, value));
  }

  /** Error-level line, at most once a minute per topic (RS-13: a throwing classifier is logged). */
  errorOnce(topic: string, message: string): void {
    if (this.allowed(`error:${topic}`)) this.logger.error(message);
  }

  warnOnce(topic: string, message: string): void {
    if (this.allowed(`warn:${topic}`)) this.logger.warn(message);
  }

  /** At most once per minute per topic. */
  allowed(topic: string): boolean {
    const now = this.options.clock.monotonic();
    const last = this.lastWarn.get(topic);
    if (last !== undefined && now - last < ONE_MINUTE_MS) return false;
    this.lastWarn.set(topic, now);
    return true;
  }

  private metric(fn: () => void): void {
    try {
      fn();
    } catch {
      this.warnOnce('metrics', 'care metrics port failed');
    }
  }
}
