import { joinSelector, parseSelector, selectorMatches, SelectorTrie } from './selector';

const matches = (selector: string, path: (string | number)[], fold = true): boolean => {
  const trie = new SelectorTrie<string>();
  trie.insert(parseSelector(selector), fold, selector);
  let state = trie.start();
  for (const step of path) state = trie.step(state, step);
  return trie.terminals(state).length > 0;
};

describe('selector grammar (6.1)', () => {
  it('SD-08 selector grammar: dots, [*], **, quoted keys, case', () => {
    expect(matches('accounts[*].authToken', ['accounts', 2, 'authToken'])).toBe(true);
    expect(matches('accounts[*].authToken', ['accounts', 'x', 'authToken'])).toBe(false);
    expect(matches('**.password', ['password'])).toBe(true);
    expect(matches('**.password', ['a', 0, 'b', 'PassWord'])).toBe(true);
    expect(matches('**.password', ['a', 0, 'b', 'PassWord'], false)).toBe(false);
    expect(matches('a["x.y"]', ['a', 'x.y'])).toBe(true);
    expect(matches('a["x.y"]', ['a', 'x', 'y'])).toBe(false);
    expect(matches('a.*.c', ['a', 'b', 'c'])).toBe(true);
    expect(matches('a.*.c', ['a', 0, 'c'])).toBe(false);
    expect(matches('a.**', ['a'])).toBe(true);
    expect(matches('a.**', ['a', 'b', 0])).toBe(true);
    expect(matches('a.**.c', ['a', 'c'])).toBe(true);
    expect(matches('a.**.c', ['a', 'x', 1, 'c'])).toBe(true);
    expect(matches('a.**.c', ['a', 'x', 1, 'd'])).toBe(false);
  });

  it('SD-08 a bare name matches the root key only (D4)', () => {
    expect(matches('token', ['token'])).toBe(true);
    expect(matches('token', ['a', 'token'])).toBe(false);
  });

  it('SD-08 invalid selectors do not parse', () => {
    for (const bad of ['a..b', '', 'a.', '.a', 'a[x]', 'a["x"', 'a[""]', 'a b', 'a[*', '***']) {
      expect(() => parseSelector(bad)).toThrow();
    }
    expect(parseSelector('["x.y"].z')).toEqual([
      { kind: 'key', key: 'x.y' },
      { kind: 'key', key: 'z' },
    ]);
  });

  it('joins prefixes and quotes keys that the bare form cannot hold', () => {
    expect(joinSelector('accounts[*]', 'authToken')).toBe('accounts[*].authToken');
    expect(joinSelector(undefined, 'a.b')).toBe('["a.b"]');
    expect(joinSelector('x', 'a.b')).toBe('x["a.b"]');
    expect(selectorMatches(parseSelector('x["a.b"]'), ['x', 'a.b'])).toBe(true);
  });
});
