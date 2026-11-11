/**
 * SD-40: `src/sensitive` imports no npm package and only its own files. The rules live in
 * `.dependency-cruiser.cjs` and `npm run bounds` enforces them on the real tree; this spec proves the
 * npm and leaf rules bite on fixtures. dependency-cruiser is ESM-only, so the cruise runs in a child `node`.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

interface Rule {
  name: string;
  severity: string;
  from: { path: string; pathNot?: string };
  to: { path?: string; pathNot?: string; dependencyTypes?: string[] };
}

interface Violation {
  from: string;
  to: string;
  rule: { name: string };
}

const root = join(__dirname, '..');
const FIXTURE = 'test/fixtures/sensitive-npm';
const LEAF_FIXTURE = 'test/fixtures/sensitive-leaf';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the config is a CommonJS file
const config = require('../.dependency-cruiser.cjs') as { forbidden: Rule[] };

function rule(name: string): Rule {
  const found = config.forbidden.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`rule ${name} is missing`);
  return found;
}

const script = `
const { cruise } = await import('dependency-cruiser');
const { targets, forbidden } = JSON.parse(process.env.SD40_INPUT);
const result = await cruise(
  targets,
  { validate: true, ruleSet: { forbidden }, doNotFollow: { path: 'node_modules' } },
  { extensions: ['.ts', '.js', '.mjs'] },
);
console.log(JSON.stringify(result.output.summary.violations));
`;

function cruise(targets: string[], forbidden: Rule[]): Violation[] {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SD40_INPUT: JSON.stringify({ targets, forbidden }) },
  });
  return JSON.parse(out.trim()) as Violation[];
}

describe('privacy layer boundaries (SD-40)', () => {
  it('SD-40 declares sensitive-no-npm and sensitive-is-leaf as errors', () => {
    expect(rule('sensitive-no-npm').severity).toBe('error');
    expect(rule('sensitive-no-npm').from.path).toBe('^src/sensitive/');
    const leaf = rule('sensitive-is-leaf');
    expect(leaf.severity).toBe('error');
    const target = new RegExp(leaf.to.path ?? '$^');
    const allowed = new RegExp(leaf.to.pathNot ?? '$^');
    expect(target.test('src/resilience/x.ts') && !allowed.test('src/resilience/x.ts')).toBe(true);
    expect(allowed.test('src/sensitive/x.ts')).toBe(true);
  });

  it('SD-40 depcruise sensitive-no-npm forbids npm imports and allows node: modules', () => {
    const fixtureRule = { ...rule('sensitive-no-npm'), from: { path: `^${FIXTURE}/` } };
    const violations = cruise([FIXTURE], [fixtureRule]);
    expect(violations.map((v) => [v.rule.name, v.from])).toEqual([
      ['sensitive-no-npm', `${FIXTURE}/npm-import.ts`],
    ]);
  }, 30_000);

  it('SD-40 depcruise sensitive-is-leaf forbids imports of other src folders and allows siblings', () => {
    const leaf = rule('sensitive-is-leaf');
    const fixtureRule = {
      ...leaf,
      from: { path: `^${LEAF_FIXTURE}/` },
      to: { path: '^src/', pathNot: `^${LEAF_FIXTURE}/` },
    };
    const violations = cruise([LEAF_FIXTURE], [fixtureRule]);
    expect(violations.map((v) => [v.rule.name, v.from, v.to])).toEqual([
      ['sensitive-is-leaf', `${LEAF_FIXTURE}/src-import.ts`, 'src/message.ts'],
    ]);
  }, 30_000);

  it('SD-40 the real src/sensitive tree has no violation of either rule', () => {
    const violations = cruise(
      ['src/sensitive'],
      [rule('sensitive-no-npm'), rule('sensitive-is-leaf')],
    );
    expect(violations).toEqual([]);
  }, 30_000);
});
