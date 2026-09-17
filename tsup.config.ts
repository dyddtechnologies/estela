import { defineConfig } from 'tsup';

/**
 * Build dual ESM + CJS (plan §4.2).
 * Con "type": "commonjs", tsup emite .js (CJS) y .mjs (ESM) — coincide
 * con el exports map de package.json.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/testing/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
});
