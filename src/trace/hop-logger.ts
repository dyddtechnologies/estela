import { Logger } from '@nestjs/common';
import type { MessageHeaders } from '../message';

/**
 * Opt-in runtime logging that brackets every flow and every activator hop, so
 * each line distinguishes the flow, the channel and the correlation
 * (traceId + correlationId). Off by default: no behavior change unless
 * `IntegrationModule.forRoot({ logging: { hops: true } })`.
 */
/** Nest log level used for the hop lines. */
export type HopLogLevel = 'log' | 'debug' | 'verbose';

export interface IntegrationLoggingOptions {
  /** Emit an enter/exit line per flow and per activator hop. Default false. */
  hops?: boolean;
  /** Level for the hop lines. Default 'log'. */
  level?: HopLogLevel;
  /** Print the startup banner once per process. Default true; ESTELA_BANNER=false also disables it. */
  banner?: boolean;
}

export class HopLogger {
  private readonly logger = new Logger('IntegrationRuntime');
  private readonly level: HopLogLevel;

  constructor(level: HopLogLevel = 'log') {
    this.level = level;
  }

  /** Flow, channel and correlation: the three axes each line distinguishes. */
  private tag(h: MessageHeaders): string {
    return `trace=${h.traceId} corr=${h.correlationId}`;
  }

  private emit(line: string): void {
    this.logger[this.level](line);
  }

  flowStart(flow: string, channel: string, h: MessageHeaders): void {
    this.emit(`▶ flow ${flow} on ${channel} [${this.tag(h)}]`);
  }

  flowEnd(flow: string, channel: string, h: MessageHeaders, status: string, ms: number): void {
    this.emit(`■ flow ${flow} on ${channel} ${status} ${ms}ms [${this.tag(h)}]`);
  }

  hopStart(channel: string, target: string, h: MessageHeaders): void {
    this.emit(`→ hop ${channel} ${target} [${this.tag(h)}]`);
  }

  hopEnd(channel: string, target: string, h: MessageHeaders, ok: boolean, ms: number): void {
    this.emit(`← hop ${channel} ${target} ${ok ? 'ok' : 'FAIL'} ${ms}ms [${this.tag(h)}]`);
  }
}
