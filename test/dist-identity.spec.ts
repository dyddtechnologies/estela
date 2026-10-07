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
