const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const sonarjs = require('eslint-plugin-sonarjs');
const security = require('eslint-plugin-security');

/**
 * ESTELA — strict lint gate (plan §12 "nivel más alto"):
 * type-checked TypeScript + SonarQube rules (bugs/smells/cognitive complexity)
 * + security plugin. Formatting lives in Prettier; complexity caps below.
 */
module.exports = tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'assets/',
      '**/*.md',
      '*.js',
      'jest.config.js',
      'tsup.config.ts',
      '.dependency-cruiser.cjs',
      '.github/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: { project: true, tsconfigRootDir: __dirname },
    },
    plugins: { sonarjs, security },
    rules: {
      ...sonarjs.configs.recommended.rules,
      ...security.configs.recommended.rules,
      'security/detect-object-injection': 'off', // headers index signature by design
      'security/detect-non-literal-regexp': 'off', // glob.ts escapes by construction
      'no-console': 'error',
      complexity: ['error', 12],
      'max-depth': ['error', 4],
      'max-lines-per-function': ['error', { max: 110, skipBlankLines: true, skipComments: true }],
      'sonarjs/cognitive-complexity': ['error', 15],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      'max-lines-per-function': 'off',
      complexity: 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-identical-functions': 'off',
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/no-alphabetical-sort': 'off',
      'require-await': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // El contrato IdempotencyStore ES async (Redis); memoria/no-op no necesitan await.
    files: ['src/idempotency/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
);
