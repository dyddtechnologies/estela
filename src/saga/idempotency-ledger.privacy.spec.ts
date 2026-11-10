import { IdempotencyInProgressError } from './idempotency-ledger';

describe('SD-43 in-progress error (S12)', () => {
  it('in-progress errors keep the key out of message', () => {
    const error = new IdempotencyInProgressError('saga:pay', 'K-CANARY-555');
    expect(error.message).toBe('IDEMPOTENCY_KEY_IN_PROGRESS: saga:pay');
    expect(error.message).not.toContain('K-CANARY-555');
    expect(String(error)).not.toContain('K-CANARY-555');
    // App code still reads the key from the property.
    expect(error.key).toBe('K-CANARY-555');
  });
});
