/**
 * RU-05 (RS-05): `src/resilience` imports no npm package. The rule lives in
 * `.dependency-cruiser.cjs` and `npm run bounds` enforces it on the real tree; this spec proves
 * the rule bites, by running dependency-cruiser's API on a fixture with the rule's `from.path`
 * pointed at the fixture folder. dependency-cruiser is ESM-only, so the cruise runs in a child
 * `node` process, outside jest's module system.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

interface Rule {
  name: string;
  severity: string;
  from: { path: string; pathNot?: string };
  to: { path?: string; dependencyTypes?: string[] };
}

interface Violation {
  from: string;
  to: string;
  rule: { name: string };
}

const root = join(__dirname, '..');
const FIXTURE = 'test/fixtures/resilience-npm';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the config is a CommonJS file
const config = require('../.dependency-cruiser.cjs') as { forbidden: Rule[] };

function rule(name: string): Rule {
  const found = config.forbidden.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`rule ${name} is missing`);
  return found;
}

const script = `
const { cruise } = await import('dependency-cruiser');
const { targets, forbidden } = JSON.parse(process.env.RU05_INPUT);
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
    env: { ...process.env, RU05_INPUT: JSON.stringify({ targets, forbidden }) },
  });
  return JSON.parse(out.trim()) as Violation[];
}

describe('resilience layer boundaries (RS-05)', () => {
  it('RU-05 declares resilience-no-npm and resilience-is-leaf as errors', () => {
    const noNpm = rule('resilience-no-npm');
    expect(noNpm.severity).toBe('error');
    expect(noNpm.from.path).toBe('^src/resilience/');
    expect(noNpm.to.dependencyTypes).toEqual(
      expect.arrayContaining(['npm', 'npm-peer', 'npm-dev']),
    );
    const leaf = rule('resilience-is-leaf');
    expect(leaf.severity).toBe('error');
    const target = new RegExp(leaf.to.path ?? '$^');
    for (const layer of ['outbound', 'inbound', 'activator', 'saga', 'flow']) {
      expect(target.test(`src/${layer}/x.ts`)).toBe(true);
    }
    expect(target.test('src/channel.ts')).toBe(false);
  });

  it('RU-05 depcruise forbids npm imports under src/resilience', () => {
    const fixtureRule = { ...rule('resilience-no-npm'), from: { path: `^${FIXTURE}/` } };
    const violations = cruise([FIXTURE], [fixtureRule]);
    expect(violations.map((v) => [v.rule.name, v.from])).toEqual([
      ['resilience-no-npm', `${FIXTURE}/npm-import.ts`],
    ]);
    expect(violations[0]?.to).toContain('node_modules/rxjs');
  }, 30_000);

  it('RU-05 the real src/resilience tree has no violation of either rule', () => {
    const violations = cruise(
      ['src/resilience'],
      [rule('resilience-no-npm'), rule('resilience-is-leaf')],
    );
    expect(violations).toEqual([]);
  }, 30_000);
});
