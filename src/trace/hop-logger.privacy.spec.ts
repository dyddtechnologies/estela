import { Logger } from '@nestjs/common';
import { createMessage } from '../message';
import { PrivacyEngine } from '../sensitive/privacy-engine';
import { HopLogger } from './hop-logger';
import { SagaTracer } from '../saga/saga-tracer';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlLWNhbmFyeS0wMDE';
const CANARY = 'XCANARY1234';

function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')) as never);
  return { lines, restore: () => spy.mockRestore() };
}

function failure(): Error {
  const cause = new Error(`cause token ${CANARY}`);
  const error = new Error(`upstream said Bearer ${JWT}`, { cause });
  error.stack = `Error: upstream said Bearer ${JWT}\n    at work (${CANARY}.ts:1:1)`;
  return error;
}

const headers = createMessage(null, { correlationId: 'corr-1' }).headers;

describe('S1 and S2 error lines (SD-11, section 2 baseline)', () => {
  it('hop error line applies the baseline without a module engine', () => {
    const { lines, restore } = captureErrors();
    new HopLogger('log').hopError('saga:pay', 'afterCommit', headers, failure());
    restore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(JWT);
    expect(lines[0]).toContain('ERROR Error: upstream said Bearer [HIDDEN:');
    expect(lines[0]).toContain('corr=corr-1');
  });

  it('patterns redact nested strings, messages, stacks and causes', async () => {
    const engine = await PrivacyEngine.compile({
      patterns: [{ name: 'test.x', regex: /XCANARY\d{4}/ }],
    });
    const { lines, restore } = captureErrors();
    new HopLogger('log', engine).hopError('saga:pay', 'afterCommit', headers, failure());
    new SagaTracer(undefined, engine).error('pay', 'afterCommit', headers, failure());
    restore();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(CANARY);
      expect(line).not.toContain(JWT);
    }
    expect(lines[0]).toContain('[HIDDEN:test.x]');
  });

  it('saga fallback line applies the baseline', () => {
    const { lines, restore } = captureErrors();
    new SagaTracer().error('pay', 'afterCommit', headers, failure());
    restore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(JWT);
    expect(lines[0]).toContain('saga:pay afterCommit failed: upstream said Bearer [HIDDEN:');
  });

  it('compat: privacy false keeps 0.9.0 log text', async () => {
    const engine = await PrivacyEngine.compile(false);
    const { lines, restore } = captureErrors();
    const error = failure();
    new HopLogger('log', engine).hopError('saga:pay', 'afterCommit', headers, error);
    new SagaTracer(undefined, engine).error('pay', 'afterCommit', headers, error);
    restore();
    expect(lines[0]).toBe(
      `✖ hop saga:pay afterCommit ERROR Error: ${error.message} [trace=${headers.traceId} corr=corr-1] ${error.stack}`,
    );
    expect(lines[1]).toBe(
      `saga:pay afterCommit failed: ${error.message} [corr=corr-1] ${error.stack}`,
    );
  });
});
