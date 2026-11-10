import { Logger } from '@nestjs/common';
import type { MessageHeaders } from '../message';
import type { HopLogger } from '../trace/hop-logger';
import type { PrivacyEngine } from '../sensitive/privacy-engine';
import { errorForLog } from '../trace/trail';

/** Brackets saga work in hop lines, and reports failures that must never be silent. */
export class SagaTracer {
  private static readonly fallback = new Logger('EstelaSaga');

  /** `privacy`: the runner's engine; without it the fallback line applies the baseline (S2). */
  constructor(
    private readonly logger?: HopLogger,
    private readonly privacy?: PrivacyEngine,
  ) {}

  async traced(
    sagaName: string,
    target: string,
    headers: MessageHeaders,
    work: () => Promise<void> | void,
  ): Promise<void> {
    const channel = `saga:${sagaName}`;
    const started = Date.now();
    this.logger?.hopStart(channel, target, headers);
    let ok = false;
    try {
      await work();
      ok = true;
    } finally {
      this.logger?.hopEnd(channel, target, headers, ok, Date.now() - started);
    }
  }

  /** Error-level report: through the hop logger when configured, a static Nest Logger otherwise. */
  error(sagaName: string, target: string, headers: MessageHeaders, error: unknown): void {
    if (this.logger !== undefined) {
      this.logger.hopError(`saga:${sagaName}`, target, headers, error);
      return;
    }
    const { message, stack } = errorForLog(this.privacy, error, { channel: `saga:${sagaName}` });
    SagaTracer.fallback.error(
      `saga:${sagaName} ${target} failed: ${message} [corr=${headers.correlationId}]`,
      stack,
    );
  }
}
