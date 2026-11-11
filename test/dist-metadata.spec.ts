/**
 * Built-package check: every class Nest instantiates (@Injectable or @Controller) must carry
 * `design:paramtypes` in the published CJS and ESM builds. Without it Nest injects `undefined` into
 * each constructor parameter that has no explicit @Inject (SPI-452: IntegrationRuntime failed with
 * "Cannot read properties of undefined (reading 'tryGet')"). The specs import the sources through
 * ts-jest, which always emits the metadata, so only the built dist can show the regression.
 *
 * It runs plain `node` on the dist, outside jest's module system, and does not preload
 * reflect-metadata: the dist must load it itself (through @nestjs/common) before its decorators run.
 * Skipped when dist has not been built, except under `npm run test:dist`, where a missing dist fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const distRequired = process.env.npm_lifecycle_event === 'test:dist';
const built = ['dist/index.js', 'dist/index.mjs'].every((file) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed paths under the repo root
  existsSync(join(root, file)),
);
const d = built || distRequired ? describe : describe.skip;

interface ClassReport {
  name: string;
  arity: number;
  paramtypes: number | null;
}

/** Lists every exported DI-managed class with its constructor arity and recorded paramtypes. */
const probe = (load: string): string => `
${load}
const managed = Object.entries(main).filter(([, value]) =>
  typeof value === 'function' &&
  /^class[\\s{]/.test(Function.prototype.toString.call(value)) &&
  (Reflect.getMetadata('__injectable__', value) === true ||
    Reflect.getMetadata('__controller__', value) === true),
);
console.log(JSON.stringify(managed.map(([name, value]) => {
  const types = Reflect.getMetadata('design:paramtypes', value);
  return { name, arity: value.length, paramtypes: Array.isArray(types) ? types.length : null };
})));
`;

function run(source: string, type: 'commonjs' | 'module'): ClassReport[] {
  const script =
    type === 'commonjs' ? `(async () => {${source}})().catch((e) => { throw e; });` : source;
  const out = execFileSync(process.execPath, [`--input-type=${type}`, '-e', script], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(out.trim()) as ClassReport[];
}

/** Classes whose constructors take parameters but whose recorded paramtypes are missing or short. */
function missingMetadata(classes: ClassReport[]): ClassReport[] {
  return classes.filter((c) => c.arity > 0 && c.paramtypes !== c.arity);
}

// The three classes Nest builds with constructor injection today; the list may grow, never shrink
// silently (an empty discovery would otherwise pass vacuously).
const knownInjected = ['ChannelGraphController', 'InboundInterceptor', 'IntegrationRuntime'];

const formats: [string, string, 'commonjs' | 'module'][] = [
  ['CJS dist/index.js', "const main = require('./dist/index.js');", 'commonjs'],
  ['ESM dist/index.mjs', "const main = await import('./dist/index.mjs');", 'module'],
];

d('dist: decorator metadata survives the build', () => {
  it('dist is built', () => {
    expect(built).toBe(true);
  });

  it.each(formats)('%s: every injectable constructor has design:paramtypes', (_, load, type) => {
    const classes = run(probe(load), type);
    const withParams = classes.filter((c) => c.arity > 0).map((c) => c.name);
    expect(withParams).toEqual(expect.arrayContaining(knownInjected));
    expect(missingMetadata(classes)).toEqual([]);
  });
});
