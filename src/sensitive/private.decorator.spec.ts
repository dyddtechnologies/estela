import { Show } from './privacy.types';
import { Private, privateEntriesOf, privateFieldsOf } from './private.decorator';

class Base {
  @Private()
  secret = 's';
  plain = 'p';
}

class Child extends Base {
  @Private({ show: Show.Ends, name: 'acct.number' })
  number = '1234567890';
}

class Account {
  @Private()
  authToken = 't';
}

describe('@Private (4.2)', () => {
  it('SD-06 @Private marks fields on instances and subclasses', () => {
    expect([...privateEntriesOf(Child).keys()]).toEqual(['secret', 'number']);
    expect([...privateEntriesOf(Base).keys()]).toEqual(['secret']);
    expect(privateEntriesOf(new Child().constructor).get('number')).toEqual({
      show: Show.Ends,
      name: 'acct.number',
    });
    const holder = Object.getOwnPropertyDescriptor(Base, Symbol.for('@estela/nest.private'));
    expect(holder?.enumerable).toBe(false);
  });

  it('SD-07 privateFieldsOf turns decorator metadata into selectors', () => {
    expect(privateFieldsOf(Account, 'accounts[*]')).toEqual([{ path: 'accounts[*].authToken' }]);
    expect(privateFieldsOf(Child)).toEqual([
      { path: 'secret' },
      { path: 'number', show: Show.Ends, name: 'acct.number' },
    ]);
  });
});
