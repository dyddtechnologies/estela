import {
  LanesFullError,
  ValveShutError,
  OutOfTimeError,
  PlanBFailedError,
  OverPaceError,
  CareConfigError,
  CareError,
  CareKeyError,
} from './resilience.errors';
import { ChannelError } from '../channel';

describe('care errors', () => {
  it('RU-44 error messages carry binding, kind and tries only', () => {
    const meta = {
      binding: 'orders.http',
      edge: 'outbound-rest' as const,
      tries: 3,
      cause: new Error('https://h/p?token=secret +50255501234'),
    };
    const errors = [
      new ValveShutError(meta),
      new LanesFullError({ ...meta, reason: 'full' }),
      new OverPaceError({ ...meta, readyInMs: 5 }),
      new OutOfTimeError({ ...meta, totalMs: 5 }),
      new PlanBFailedError({ ...meta, original: new Error('x') }),
      new CareKeyError({ ...meta, reason: 'key-fn' }),
    ];
    expect(errors.map((e) => e.message)).toEqual([
      "valve shut for outbound rest 'orders.http' after 3 try(ies)",
      "lanes full for outbound rest 'orders.http' after 3 try(ies)",
      "over pace for outbound rest 'orders.http' after 3 try(ies)",
      "out of time for outbound rest 'orders.http' after 3 try(ies)",
      "plan B failed for outbound rest 'orders.http' after 3 try(ies)",
      "care key error (key-fn) for outbound rest 'orders.http' after 3 try(ies)",
    ]);
    for (const error of errors) {
      expect(error.message).not.toContain('secret');
      expect(error.message).not.toContain('50255501234');
      expect(error.cause).toBe(meta.cause);
      expect(error).toBeInstanceOf(CareError);
      expect(error).toBeInstanceOf(ChannelError);
      expect(error.name).toBe(error.constructor.name);
    }
    expect(new CareConfigError('b', 'tries.max', 'must be x').message).toBe(
      'b: care.tries.max must be x',
    );
  });

  it('keeps instanceof for branded foreign copies and plain subclasses', () => {
    const foreign = Object.assign(Object.create(Error.prototype) as object, {
      kind: 'valve-shut',
      [Symbol.for('@estela/nest.CareError')]: true,
    });
    expect(foreign).toBeInstanceOf(ValveShutError);
    expect(foreign).toBeInstanceOf(CareError);
    expect(foreign).not.toBeInstanceOf(LanesFullError);
    class Custom extends ValveShutError {}
    expect(new ValveShutError({ binding: 'b' })).not.toBeInstanceOf(Custom);
  });
});
