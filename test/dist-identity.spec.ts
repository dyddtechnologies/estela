/**
 * Built-package check: the `.` and `./testing` entries must share one copy of every class, in both
 * the CJS and the ESM build, or `instanceof` breaks across them (a LockTimeoutError thrown by
 * MemoryLockPort would not be a ConcurrencyError, and retry on 'lock-timeout' would never fire).
 * The specs import the sources, so only the built dist can show this. It runs plain `node` on the
 * dist, outside jest's module system, and is skipped when dist has not been built (`npm run
 * verify` always builds before it tests).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const built = ['dist/index.js', 'dist/testing/index.mjs'].every((file) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed paths under the repo root
  existsSync(join(root, file)),
);
const d = built ? describe : describe.skip;

/** Times out one exclusive MemoryLockPort request and prints what the main entry thinks of it. */
const probe = (load: string): string => `
${load}
const port = new testing.MemoryLockPort({ defaultTimeoutMs: 5 });
const request = [{ namespace: 'n', key: 'k', mode: 'exclusive' }];
await port.acquire(null, request, { onRelease() {} });
const error = await port.acquire(null, request, { onRelease() {} }).catch((e) => e);
console.log(JSON.stringify({
  name: error.name,
  lockTimeout: error instanceof main.LockTimeoutError,
  concurrency: error instanceof main.ConcurrencyError,
}));
`;

function run(source: string, type: 'commonjs' | 'module'): unknown {
  const script =
    type === 'commonjs' ? `(async () => {${source}})().catch((e) => { throw e; });` : source;
  const out = execFileSync(process.execPath, [`--input-type=${type}`, '-e', script], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(out.trim()) as unknown;
}

const expected = { name: 'LockTimeoutError', lockTimeout: true, concurrency: true };

d('dist: one class identity across the main and testing entries', () => {
  it('CJS: errors from @estela/nest/testing are instances of the @estela/nest classes', () => {
    const load =
      "const main = require('./dist/index.js'); const testing = require('./dist/testing/index.js');";
    expect(run(probe(load), 'commonjs')).toEqual(expected);
  });

  it('ESM: errors from @estela/nest/testing are instances of the @estela/nest classes', () => {
    const load =
      "const main = await import('./dist/index.mjs'); const testing = await import('./dist/testing/index.mjs');";
    expect(run(probe(load), 'module')).toEqual(expected);
  });
});

/**
 * RU-46 (RS-46): a CareError subclass built inside the testing bundle. `bindFlow` resolves
 * the flow's parameters with the testing entry's own copy of FlowParameterResolver (the CJS build
 * inlines it), so an unknown profile throws that copy's CareConfigError; the brand must
 * make it an instance of the main entry's classes.
 */
const resilienceProbe = (load: string): string => `
${load}
const runtime = new main.CareEngine({}, { enabled: false });
const registry = new main.ChannelRegistry({ trace: new main.TraceContext() });
const flow = main.IntegrationFlow.from('ru46.in').handle((p) => p, { care: 'missing-profile' });
let error;
try {
  testing.bindFlow({ name: 'ru46', build: () => flow }, registry, { care: runtime });
} catch (caught) {
  error = caught;
}
console.log(JSON.stringify({
  name: error?.name,
  code: error?.code,
  definition: error instanceof main.CareConfigError,
  care: error instanceof main.CareError,
  circuitOpen: error instanceof main.ValveShutError,
}));
`;

const resilienceExpected = {
  name: 'CareConfigError',
  code: 'UNKNOWN_PROFILE',
  definition: true,
  care: true,
  circuitOpen: false,
};

d('dist: resilience errors keep instanceof across the main and testing entries (RU-46)', () => {
  it('CJS: a CareConfigError built by the testing bundle is a main-bundle instance', () => {
    const load =
      "const main = require('./dist/index.js'); const testing = require('./dist/testing/index.js');";
    expect(run(resilienceProbe(load), 'commonjs')).toEqual(resilienceExpected);
  });

  it('ESM: a CareConfigError built by the testing bundle is a main-bundle instance', () => {
    const load =
      "const main = await import('./dist/index.mjs'); const testing = await import('./dist/testing/index.mjs');";
    expect(run(resilienceProbe(load), 'module')).toEqual(resilienceExpected);
  });
});
