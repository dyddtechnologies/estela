import { ResilienceScope } from './retry-budget';
import type {
  ResilienceClock,
  ResilienceEvent,
  ResilienceLogger,
  ResilienceMetricsPort,
} from './resilience.types';

const ONE_MINUTE_MS = 60_000;

export const noopResilienceLogger: ResilienceLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export interface ResilienceObserverOptions {
  clock: ResilienceClock;
  logger?: ResilienceLogger;
  metrics?: ResilienceMetricsPort;
  onEvent?: (event: ResilienceEvent) => void;
  /** Fire-and-forget publisher of the events channel (RS-40). */
  publish?: (event: ResilienceEvent) => Promise<void>;
}

/**
 * Event, metrics and log fan-out of the engine (RS-40, RS-41, RS-45). Nothing here is awaited on
 * the call path, and sink failures are swallowed with at most one warn line per minute (I7).
 */
export class ResilienceObserver {
  readonly logger: ResilienceLogger;
  private readonly lastWarn = new Map<string, number>();

  constructor(private readonly options: ResilienceObserverOptions) {
    this.logger = options.logger ?? noopResilienceLogger;
  }

  emit(event: Omit<ResilienceEvent, 'at'>): void {
    if (ResilienceScope.current()?.fromEventsChannel === true) return;
    const full: ResilienceEvent = { ...event, at: this.options.clock.wall() };
    try {
      this.options.onEvent?.(full);
    } catch {
      this.warnOnce('events', 'resilience event hook failed');
    }
    const publish = this.options.publish;
    if (publish === undefined) return;
    const warn = (): void => this.warnOnce('events', 'resilience events channel publish failed');
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

  /** Error-level line, rate limited per topic (RS-13: a throwing classifier is logged). */
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
      this.warnOnce('metrics', 'resilience metrics port failed');
    }
  }
}
