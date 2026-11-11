import { defineConfig } from 'tsup';

/**
 * Dual ESM + CJS build (plan §4.2). With "type": "commonjs", tsup emits .js (CJS) and .mjs (ESM),
 * matching the exports map in package.json.
 *
 * Decorator metadata: esbuild cannot emit `design:paramtypes`, and without it Nest injects
 * `undefined` into every constructor parameter that has no explicit @Inject (SPI-452). tsup
 * transforms the sources with SWC instead when tsconfig.json sets `emitDecoratorMetadata` and
 * `@swc/core` is installed, so both must stay. test/dist-metadata.spec.ts guards the result.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/testing/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
});
