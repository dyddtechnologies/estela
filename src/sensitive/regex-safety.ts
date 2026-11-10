/**
 * Boot analysis of pattern rules for the native (backtracking) engine (6.5, SD-19), and the
 * RE2-syntax check of the built-in packs (SD-13). The pattern source is parsed into a small AST;
 * the checks are conservative and may reject a safe pattern.
 */

/**
 * Character sets over ASCII plus two buckets for non-ASCII code points: Unicode spaces (so `\s`
 * and `\S` stay disjoint) and every other one.
 */
const NON_ASCII = 128;
const NON_ASCII_SPACE = 129;
const SET_SIZE = 130;

class CharSet {
  readonly bits = new Uint8Array(SET_SIZE);

  static of(...codes: number[]): CharSet {
    const set = new CharSet();
    for (const code of codes) set.add(code);
    return set;
  }

  static full(): CharSet {
    const set = new CharSet();
    set.bits.fill(1);
    return set;
  }

  add(code: number): this {
    this.bits[code < NON_ASCII ? code : NON_ASCII] = 1;
    return this;
  }

  addRange(from: number, to: number): this {
    for (let code = from; code <= Math.min(to, NON_ASCII); code++) this.add(code);
    return this;
  }

  addSet(other: CharSet): this {
    for (let i = 0; i < SET_SIZE; i++) if (other.bits[i] === 1) this.bits[i] = 1;
    return this;
  }

  negate(): CharSet {
    const out = new CharSet();
    for (let i = 0; i < SET_SIZE; i++) out.bits[i] = this.bits[i] === 1 ? 0 : 1;
    return out;
  }

  intersects(other: CharSet): boolean {
    for (let i = 0; i < SET_SIZE; i++) if (this.bits[i] === 1 && other.bits[i] === 1) return true;
    return false;
  }

  foldCase(): this {
    for (let code = 65; code <= 90; code++) {
      if (this.bits[code] === 1 || this.bits[code + 32] === 1) {
        this.bits[code] = 1;
        this.bits[code + 32] = 1;
      }
    }
    return this;
  }
}

const code = (ch: string): number => ch.codePointAt(0) ?? 0;
const DIGITS = new CharSet().addRange(48, 57);
const WORD = new CharSet().addRange(48, 57).addRange(65, 90).addRange(97, 122).add(95);
const SPACE = CharSet.of(9, 10, 11, 12, 13, 32);
SPACE.bits[NON_ASCII_SPACE] = 1;

type Node =
  | { t: 'set'; set: CharSet }
  | { t: 'seq'; items: Node[] }
  | { t: 'alt'; branches: Node[] }
  | { t: 'group'; body: Node }
  | { t: 'look'; body: Node }
  | { t: 'assert' }
  | { t: 'backref' }
  | { t: 'quant'; body: Node; min: number; max: number };

export class RegexSyntaxError extends Error {}

const CLASS_ESCAPES: Readonly<Record<string, () => CharSet>> = {
  d: () => new CharSet().addSet(DIGITS),
  D: () => DIGITS.negate(),
  w: () => new CharSet().addSet(WORD),
  W: () => WORD.negate(),
  s: () => new CharSet().addSet(SPACE),
  S: () => SPACE.negate(),
};

const CONTROL_ESCAPES: Readonly<Record<string, number>> = {
  n: 10,
  r: 13,
  t: 9,
  f: 12,
  v: 11,
  '0': 0,
};

class Parser {
  private at = 0;

  constructor(
    private readonly source: string,
    private readonly flags: string,
  ) {}

  parse(): Node {
    const node = this.alternation();
    if (this.at < this.source.length) throw new RegexSyntaxError('unbalanced parenthesis');
    return node;
  }

  private peek(offset = 0): string | undefined {
    return this.source[this.at + offset];
  }

  private alternation(): Node {
    const branches = [this.sequence()];
    while (this.peek() === '|') {
      this.at++;
      branches.push(this.sequence());
    }
    return branches.length === 1 ? branches[0]! : { t: 'alt', branches };
  }

  private sequence(): Node {
    const items: Node[] = [];
    while (this.at < this.source.length && this.peek() !== '|' && this.peek() !== ')') {
      items.push(this.quantified(this.atom()));
    }
    return { t: 'seq', items };
  }

  private quantified(body: Node): Node {
    const bounds = this.quantifier();
    if (bounds === undefined) return body;
    if (this.peek() === '?') this.at++;
    return { t: 'quant', body, min: bounds[0], max: bounds[1] };
  }

  private quantifier(): [number, number] | undefined {
    const ch = this.peek();
    if (ch === '*' || ch === '+' || ch === '?') {
      this.at++;
      if (ch === '*') return [0, Infinity];
      return ch === '+' ? [1, Infinity] : [0, 1];
    }
    if (ch !== '{') return undefined;
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored, digits only: linear
    const match = /^\{(\d+)(,(\d*))?\}/.exec(this.source.slice(this.at));
    if (match === null) return undefined;
    this.at += match[0].length;
    const min = Number(match[1]);
    if (match[2] === undefined) return [min, min];
    return [min, match[3] === '' ? Infinity : Number(match[3])];
  }

  private atom(): Node {
    const ch = this.peek()!;
    this.at++;
    switch (ch) {
      case '(':
        return this.group();
      case '[':
        return { t: 'set', set: this.fold(this.charClass()) };
      case '\\':
        return this.escape();
      case '.':
        return {
          t: 'set',
          set: this.flags.includes('s') ? CharSet.full() : CharSet.of(10).negate(),
        };
      case '^':
      case '$':
        return { t: 'assert' };
      case '*':
      case '+':
      case '?':
        throw new RegexSyntaxError('nothing to repeat');
      default:
        return { t: 'set', set: this.fold(CharSet.of(code(ch))) };
    }
  }

  private fold(set: CharSet): CharSet {
    return this.flags.includes('i') ? set.foldCase() : set;
  }

  private group(): Node {
    let look = false;
    const rest = this.source.slice(this.at);
    const head = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(rest);
    if (head !== null) {
      look = head[0] !== '?:' && !/^\?<[A-Za-z_$]/.test(head[0]);
      this.at += head[0].length;
    } else if (rest.startsWith('?')) {
      throw new RegexSyntaxError('invalid group');
    }
    const body = this.alternation();
    if (this.peek() !== ')') throw new RegexSyntaxError('unterminated group');
    this.at++;
    return look ? { t: 'look', body } : { t: 'group', body };
  }

  private escape(): Node {
    const ch = this.peek();
    if (ch === undefined) throw new RegexSyntaxError('trailing backslash');
    this.at++;
    if (ch === 'b' || ch === 'B') return { t: 'assert' };
    if (/[1-9]/.test(ch)) return { t: 'backref' };
    if (ch === 'k' && this.peek() === '<') return this.namedBackref();
    return { t: 'set', set: this.fold(this.escapeSet(ch)) };
  }

  private namedBackref(): Node {
    const close = this.source.indexOf('>', this.at);
    if (close < 0) throw new RegexSyntaxError('invalid named backreference');
    this.at = close + 1;
    return { t: 'backref' };
  }

  /** The set of an escape inside or outside a class; `ch` is the char after the backslash. */
  private escapeSet(ch: string): CharSet {
    const classEscape = CLASS_ESCAPES[ch];
    if (classEscape !== undefined) return classEscape();
    const control = CONTROL_ESCAPES[ch];
    if (control !== undefined) return CharSet.of(control);
    if (ch === 'x' || ch === 'u') return CharSet.of(this.hexEscape(ch));
    if (ch === 'p' || ch === 'P') {
      this.skipBraces();
      return CharSet.full();
    }
    if (ch === 'c') {
      this.at++;
      return CharSet.full();
    }
    return CharSet.of(code(ch));
  }

  private skipBraces(): void {
    if (this.peek() !== '{') return;
    const close = this.source.indexOf('}', this.at);
    if (close < 0) throw new RegexSyntaxError('unterminated escape');
    this.at = close + 1;
  }

  private hexEscape(kind: string): number {
    const rest = this.source.slice(this.at);
    const match =
      kind === 'x'
        ? /^[0-9A-Fa-f]{2}/.exec(rest)
        : /^(?:\{[0-9A-Fa-f]{1,6}\}|[0-9A-Fa-f]{4})/.exec(rest);
    if (match === null) return code(kind);
    this.at += match[0].length;
    return parseInt(match[0].replace(/[{}]/g, ''), 16);
  }

  private charClass(): CharSet {
    const negated = this.peek() === '^';
    if (negated) this.at++;
    const set = new CharSet();
    let first = true;
    while (this.peek() !== ']' || first) {
      if (this.peek() === undefined) throw new RegexSyntaxError('unterminated class');
      first = false;
      this.classItem(set);
    }
    this.at++;
    return negated ? set.negate() : set;
  }

  private classItem(set: CharSet): void {
    const low = this.classAtom();
    if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== undefined) {
      this.at++;
      const high = this.classAtom();
      const from = singleCode(low);
      const to = singleCode(high);
      if (from !== undefined && to !== undefined) {
        set.addRange(from, to);
        return;
      }
      set.addSet(low).addSet(high).add(code('-'));
      return;
    }
    set.addSet(low);
  }

  /** One class member as a set (a single code point for a plain char). */
  private classAtom(): CharSet {
    const ch = this.peek() ?? '';
    this.at++;
    if (ch !== '\\') return CharSet.of(code(ch));
    const next = this.peek();
    if (next === undefined) throw new RegexSyntaxError('trailing backslash');
    this.at++;
    return next === 'b' ? CharSet.of(8) : this.escapeSet(next);
  }
}

function singleCode(set: CharSet): number | undefined {
  let found: number | undefined;
  for (let i = 0; i < NON_ASCII; i++) {
    if (set.bits[i] !== 1) continue;
    if (found !== undefined) return undefined;
    found = i;
  }
  return set.bits[NON_ASCII] === 1 || set.bits[NON_ASCII_SPACE] === 1 ? undefined : found;
}

export function parseRegex(source: string, flags = ''): Node {
  return new Parser(source, flags).parse();
}

function nullable(node: Node): boolean {
  switch (node.t) {
    case 'set':
      return false;
    case 'seq':
      return node.items.every(nullable);
    case 'alt':
      return node.branches.some(nullable);
    case 'group':
      return nullable(node.body);
    case 'quant':
      return node.min === 0 || nullable(node.body);
    default:
      return true;
  }
}

function firstSet(node: Node): CharSet {
  switch (node.t) {
    case 'set':
      return node.set;
    case 'seq': {
      const out = new CharSet();
      for (const item of node.items) {
        out.addSet(firstSet(item));
        if (!nullable(item)) break;
      }
      return out;
    }
    case 'alt':
      return node.branches.reduce((out, branch) => out.addSet(firstSet(branch)), new CharSet());
    case 'group':
    case 'quant':
      return firstSet(node.body);
    case 'backref':
      return CharSet.full();
    default:
      return new CharSet();
  }
}

function children(node: Node): Node[] {
  switch (node.t) {
    case 'seq':
      return node.items;
    case 'alt':
      return node.branches;
    case 'group':
    case 'look':
    case 'quant':
      return [node.body];
    default:
      return [];
  }
}

function allChars(node: Node): CharSet {
  if (node.t === 'set') return node.set;
  if (node.t === 'backref') return CharSet.full();
  return children(node).reduce((out, child) => out.addSet(allChars(child)), new CharSet());
}

function some(node: Node, test: (node: Node) => boolean): boolean {
  return test(node) || children(node).some((child) => some(child, test));
}

const isUnbounded = (node: Node): boolean =>
  (node.t === 'quant' && node.max === Infinity) ||
  (node.t === 'group' && isUnbounded(node.body)) ||
  (node.t === 'seq' && node.items.length === 1 && isUnbounded(node.items[0]!));

function unwrap(node: Node): Node {
  if (node.t === 'group') return unwrap(node.body);
  if (node.t === 'seq' && node.items.length === 1) return unwrap(node.items[0]!);
  return node;
}

function quantProblem(node: Node & { t: 'quant' }): string | undefined {
  if (node.max === Infinity && children(node).some((child) => some(child, isUnbounded))) {
    return 'nested unbounded quantifiers';
  }
  const body = unwrap(node.body);
  if (node.max > 1 && body.t === 'alt') {
    const firsts = body.branches.map(firstSet);
    for (let i = 0; i < firsts.length; i++) {
      for (let j = i + 1; j < firsts.length; j++) {
        if (firsts[i]!.intersects(firsts[j]!)) {
          return 'quantified alternation with overlapping branches';
        }
      }
    }
  }
  return undefined;
}

function sequenceProblem(items: readonly Node[]): string | undefined {
  for (let i = 0; i < items.length; i++) {
    const left = items[i]!;
    if (!isUnbounded(left)) continue;
    const leftChars = allChars(left);
    for (let j = i + 1; j < items.length; j++) {
      const right = items[j]!;
      if (isUnbounded(right) && leftChars.intersects(allChars(right))) {
        return 'adjacent unbounded quantifiers over overlapping sets';
      }
      if (!nullable(right)) break;
    }
  }
  return undefined;
}

function nodeProblem(node: Node): string | undefined {
  if (node.t === 'backref') return 'backreference';
  if (node.t === 'quant') return quantProblem(node);
  if (node.t === 'seq') return sequenceProblem(node.items);
  return undefined;
}

function firstProblem(node: Node): string | undefined {
  const own = nodeProblem(node);
  if (own !== undefined) return own;
  for (const child of children(node)) {
    const found = firstProblem(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * SD-19: the reason a pattern is unsafe for the native engine, or undefined. The reason names the
 * construct, never the pattern source.
 */
export function analyzeRegex(regex: { source: string; flags: string }): string | undefined {
  if (regex.flags.includes('y')) return 'sticky flag';
  let tree: Node;
  try {
    tree = parseRegex(regex.source, regex.flags);
  } catch (error) {
    return error instanceof RegexSyntaxError ? `syntax: ${error.message}` : 'syntax';
  }
  const problem = firstProblem(tree);
  if (problem !== undefined) return problem;
  return nullable(tree) ? 'can match an empty string' : undefined;
}

/** SD-13: the reason a pattern is outside the RE2 syntax (lookaround, backreference), or undefined. */
export function re2SyntaxProblem(regex: { source: string; flags: string }): string | undefined {
  let tree: Node;
  try {
    tree = parseRegex(regex.source, regex.flags);
  } catch {
    return 'syntax';
  }
  if (some(tree, (node) => node.t === 'look')) return 'lookaround';
  if (some(tree, (node) => node.t === 'backref')) return 'backreference';
  return undefined;
}
