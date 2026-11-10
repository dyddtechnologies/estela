/**
 * Selector grammar (6.1), compiled into a trie walked as an NFA:
 *
 *   selector := segment ('.' segment | '[*]' | '["' key '"]')*
 *   segment  := '**' | '*' | key
 *
 * `*` matches one object key, `[*]` every array element, `**` zero or more levels. A bare name
 * matches the root key only.
 */
export type SelectorToken =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'star' }
  | { readonly kind: 'element' }
  | { readonly kind: 'globstar' };

/** One step of a concrete path: an object key or an array index. */
export type PathStep = string | number;

const BARE_KEY = /^[^.[\]"*\s]+$/;

export class SelectorSyntaxError extends Error {}

function segment(text: string): SelectorToken {
  if (text === '**') return { kind: 'globstar' };
  if (text === '*') return { kind: 'star' };
  if (!BARE_KEY.test(text)) throw new SelectorSyntaxError(`invalid segment`);
  return { kind: 'key', key: text };
}

/** Reads the segment that starts at `at`; returns it and the index after it. */
function readSegment(source: string, at: number): [SelectorToken, number] {
  let end = at;
  while (end < source.length && source[end] !== '.' && source[end] !== '[') end++;
  if (end === at) throw new SelectorSyntaxError('empty segment');
  return [segment(source.slice(at, end)), end];
}

/** Reads `[*]` or `["key"]` at `at` (which holds `[`). */
function readBracket(source: string, at: number): [SelectorToken, number] {
  if (source.startsWith('[*]', at)) return [{ kind: 'element' }, at + 3];
  if (!source.startsWith('["', at)) throw new SelectorSyntaxError('invalid bracket');
  const close = source.indexOf('"]', at + 2);
  if (close < 0) throw new SelectorSyntaxError('unterminated quoted key');
  const key = source.slice(at + 2, close);
  if (key === '' || key.includes('"')) throw new SelectorSyntaxError('invalid quoted key');
  return [{ kind: 'key', key }, close + 2];
}

/** Parses a selector; throws SelectorSyntaxError (the message never holds the selector). */
export function parseSelector(source: string): SelectorToken[] {
  if (typeof source !== 'string' || source === '') throw new SelectorSyntaxError('empty');
  const tokens: SelectorToken[] = [];
  // A leading quoted key or [*] is accepted so privateFieldsOf can quote a root key.
  let [token, at] = source.startsWith('[') ? readBracket(source, 0) : readSegment(source, 0);
  tokens.push(token);
  while (at < source.length) {
    if (source[at] === '.') {
      [token, at] = readSegment(source, at + 1);
    } else {
      [token, at] = readBracket(source, at);
    }
    tokens.push(token);
  }
  return tokens;
}

/** Writes a key as a selector segment, quoting it when the bare form cannot hold it. */
export function selectorKey(key: string): string {
  return BARE_KEY.test(key) && key !== '**' && key !== '*' ? key : `["${key}"]`;
}

/** Joins a prefix selector and a key. */
export function joinSelector(prefix: string | undefined, key: string): string {
  const part = selectorKey(key);
  if (prefix === undefined || prefix === '') return part;
  return part.startsWith('[') ? `${prefix}${part}` : `${prefix}.${part}`;
}

export class TrieNode<T> {
  readonly exact = new Map<string, TrieNode<T>>();
  readonly folded = new Map<string, TrieNode<T>>();
  star: TrieNode<T> | undefined;
  element: TrieNode<T> | undefined;
  globstar: TrieNode<T> | undefined;
  readonly terminals: T[] = [];

  /** True for the node reached through `**`: it stays active on every later step. */
  constructor(readonly isGlob = false) {}
}

function child<T>(node: TrieNode<T>, token: SelectorToken, foldCase: boolean): TrieNode<T> {
  switch (token.kind) {
    case 'star':
      node.star ??= new TrieNode<T>();
      return node.star;
    case 'element':
      node.element ??= new TrieNode<T>();
      return node.element;
    case 'globstar':
      node.globstar ??= new TrieNode<T>(true);
      return node.globstar;
    default: {
      const map = foldCase ? node.folded : node.exact;
      const key = foldCase ? token.key.toLowerCase() : token.key;
      let next = map.get(key);
      if (next === undefined) {
        next = new TrieNode<T>();
        map.set(key, next);
      }
      return next;
    }
  }
}

/** A set of active trie nodes for one concrete path. */
export type TrieState<T> = readonly TrieNode<T>[];

/** Selectors compiled once at boot; matching costs O(path depth x active nodes). */
export class SelectorTrie<T> {
  readonly root = new TrieNode<T>();
  private empty = true;

  insert(tokens: readonly SelectorToken[], foldCase: boolean, terminal: T): void {
    let node = this.root;
    for (const token of tokens) node = child(node, token, foldCase);
    node.terminals.push(terminal);
    this.empty = false;
  }

  get isEmpty(): boolean {
    return this.empty;
  }

  /** State of the root value (zero steps). */
  start(): TrieState<T> {
    return closure([this.root]);
  }

  step(state: TrieState<T>, step: PathStep): TrieState<T> {
    if (state.length === 0) return state;
    const next: TrieNode<T>[] = [];
    for (const node of state) advance(node, step, next);
    return closure(next);
  }

  /** Terminals of every active node. */
  terminals(state: TrieState<T>): T[] {
    const out: T[] = [];
    for (const node of state) out.push(...node.terminals);
    return out;
  }
}

function advance<T>(node: TrieNode<T>, step: PathStep, out: TrieNode<T>[]): void {
  if (node.isGlob) out.push(node);
  if (typeof step === 'number') {
    if (node.element !== undefined) out.push(node.element);
    return;
  }
  const exact = node.exact.get(step);
  if (exact !== undefined) out.push(exact);
  const folded = node.folded.get(step.toLowerCase());
  if (folded !== undefined) out.push(folded);
  if (node.star !== undefined) out.push(node.star);
}

/** Adds every node reachable through `**` (zero levels). */
function closure<T>(nodes: readonly TrieNode<T>[]): TrieState<T> {
  const seen = new Set<TrieNode<T>>();
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.globstar !== undefined) stack.push(node.globstar);
  }
  return [...seen];
}

/** True when the compiled selector matches the concrete path (boot checks only). */
export function selectorMatches(
  tokens: readonly SelectorToken[],
  path: readonly PathStep[],
): boolean {
  const trie = new SelectorTrie<true>();
  trie.insert(tokens, true, true);
  let state = trie.start();
  for (const step of path) state = trie.step(state, step);
  return trie.terminals(state).length > 0;
}
