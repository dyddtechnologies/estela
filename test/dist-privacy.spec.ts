/**
 * Built-package checks for the privacy surface (SD-37, SD-38, SD-40). The specs import the sources,
 * so only the built dist can show that privacy errors keep `instanceof` across the ESM and CJS
 * copies, that the testing entry's `expectNoLeak` works on a capture fed by the main entry's
 * engine, and that the privacy declarations are emitted. It runs plain `node` on the dist and is
 * skipped when dist has not been built (`npm run verify` always builds before it tests).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const built = ['dist/index.js', 'dist/index.mjs', 'dist/testing/index.js', 'dist/index.d.ts'].every(
  (file) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed paths under the repo root
    existsSync(join(root, file)),
);
const d = built ? describe : describe.skip;

function runModule(source: string): unknown {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(out.trim()) as unknown;
}

/** A sealed-record error thrown by the CJS copy, checked against the ESM copy's classes. */
const errorProbe = `
import { createRequire } from 'node:module';
const esm = await import('./dist/index.mjs');
const cjs = createRequire(process.cwd() + '/')('./dist/index.js');
const results = {};
for (const name of ['SealKeyUnavailableError', 'ReplayUnavailableError', 'SealBrokenError', 'DeliveryCopyError']) {
  const error = new cjs[name]('scope:x', 'why');
  results[name] = {
    privacy: error instanceof esm.PrivacyError,
    own: error instanceof esm[name],
    other: error instanceof esm.PrivacyConfigError,
  };
}
let config;
try {
  await cjs.PrivacyEngine.compile({ fingerprintChars: 2 });
} catch (caught) {
  config = caught;
}
results.config = {
  privacy: config instanceof esm.PrivacyError,
  own: config instanceof esm.PrivacyConfigError,
  kind: config?.kind,
};
console.log(JSON.stringify(results));
`;

/** The testing entry (CJS) refuses a capture that holds a canary written by the ESM engine. */
const leakProbe = `
import { createRequire } from 'node:module';
const esm = await import('./dist/index.mjs');
const testing = createRequire(process.cwd() + '/')('./dist/testing/index.js');
const capture = testing.captureTrail();
const engine = await esm.PrivacyEngine.compile({ packs: [esm.Pack.PersonalV1] });
const canary = 'canary.person@example.com';
capture.logger.log(JSON.stringify(engine.forTrail({ email: canary }, { output: esm.TrailOutput.Log })));
let hidden;
try { testing.expectNoLeak(capture, [canary]); hidden = true; } catch { hidden = false; }
capture.logger.log('raw ' + canary);
let message = '';
try { testing.expectNoLeak(capture, [canary]); } catch (error) { message = String(error.message); }
console.log(JSON.stringify({ hidden, caught: message.length > 0, printsSecret: message.includes(canary) }));
`;

d('dist: privacy surface across the ESM, CJS and testing entries (SD-37, SD-38)', () => {
  it('privacy errors keep instanceof across ESM and CJS copies', () => {
    const own = { privacy: true, own: true, other: false };
    expect(runModule(errorProbe)).toEqual({
      SealKeyUnavailableError: own,
      ReplayUnavailableError: own,
      SealBrokenError: own,
      DeliveryCopyError: own,
      config: { privacy: true, own: true, kind: 'config' },
    });
  });

  it('expectNoLeak of the testing entry checks a capture fed by the main entry engine', () => {
    expect(runModule(leakProbe)).toEqual({ hidden: true, caught: true, printsSecret: false });
  });
});

d('dist: privacy declarations are emitted for both module formats (SD-40)', () => {
  it('the declaration files name the privacy API in final vocabulary only', () => {
    const dist = join(root, 'dist');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the dist folder only
    const text = readdirSync(dist)
      .filter((file) => /\.d\.m?ts$/.test(file))
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- files under dist
      .map((file) => readFileSync(join(dist, file), 'utf8'))
      .join('\n');
    for (const name of [
      'PrivacyModuleOptions',
      'PrivacyRef',
      'PrivacyEngine',
      'SealKeyProvider',
      'FingerprintSecretProvider',
      'TapCopy',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).not.toMatch(/\bSensitive[A-Z]\w*/);
  });
});
