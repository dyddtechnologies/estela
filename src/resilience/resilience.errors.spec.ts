import {
  BulkheadFullError,
  CircuitOpenError,
  DeadlineExceededError,
  FallbackFailedError,
  RateLimitedError,
  ResilienceDefinitionError,
  ResilienceError,
  ResilienceKeyError,
} from './resilience.errors';
import { ChannelError } from '../channel';

describe('resilience errors', () => {
  it('RU-44 error messages carry binding, kind and attempts only', () => {
    const meta = {
      binding: 'orders.http',
      edge: 'outbound-rest' as const,
      attempts: 3,
      cause: new Error('https://h/p?token=secret +50255501234'),
    };
    const errors = [
      new CircuitOpenError(meta),
      new BulkheadFullError({ ...meta, reason: 'full' }),
      new RateLimitedError({ ...meta, retryAfterMs: 5 }),
      new DeadlineExceededError({ ...meta, deadlineMs: 5 }),
      new FallbackFailedError({ ...meta, original: new Error('x') }),
      new ResilienceKeyError({ ...meta, reason: 'key-fn' }),
    ];
    expect(errors.map((e) => e.message)).toEqual([
      "circuit open for outbound rest 'orders.http' after 3 attempt(s)",
      "bulkhead full for outbound rest 'orders.http' after 3 attempt(s)",
      "rate limited for outbound rest 'orders.http' after 3 attempt(s)",
      "deadline exceeded for outbound rest 'orders.http' after 3 attempt(s)",
      "fallback failed for outbound rest 'orders.http' after 3 attempt(s)",
      "resilience key error (key-fn) for outbound rest 'orders.http' after 3 attempt(s)",
    ]);
    for (const error of errors) {
      expect(error.message).not.toContain('secret');
      expect(error.message).not.toContain('50255501234');
      expect(error.cause).toBe(meta.cause);
      expect(error).toBeInstanceOf(ResilienceError);
      expect(error).toBeInstanceOf(ChannelError);
      expect(error.name).toBe(error.constructor.name);
    }
    expect(new ResilienceDefinitionError('b', 'retry.maxAttempts', 'must be x').message).toBe(
      'b: resilience.retry.maxAttempts must be x',
    );
  });

  it('keeps instanceof for branded foreign copies and plain subclasses', () => {
    const foreign = Object.assign(Object.create(Error.prototype) as object, {
      kind: 'circuit-open',
      [Symbol.for('@estela/nest.ResilienceError')]: true,
    });
    expect(foreign).toBeInstanceOf(CircuitOpenError);
    expect(foreign).toBeInstanceOf(ResilienceError);
    expect(foreign).not.toBeInstanceOf(BulkheadFullError);
    class Custom extends CircuitOpenError {}
    expect(new CircuitOpenError({ binding: 'b' })).not.toBeInstanceOf(Custom);
  });
});
