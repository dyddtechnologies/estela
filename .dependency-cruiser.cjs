/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-no-npm-deps',
      comment:
        'Plan §4.1: el dominio (message, channel, flow-step) no depende de paquetes npm. ' +
        'Core de Node permitido (p. ej. node:crypto para newId).',
      severity: 'error',
      from: {
        path: '^(src/message\\.ts|src/channel\\.ts|src/flow/flow-step\\.ts)$',
      },
      to: {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-no-pkg',
          'npm-unknown',
        ],
      },
    },
    {
      name: 'barrel-no-broker-clients',
      comment: 'Spec §15 / plan §4.2: el barrel público jamás arrastra amqplib o @grpc/grpc-js.',
      severity: 'error',
      from: { path: '^src/index\\.ts$' },
      to: { path: 'node_modules[\\/](amqplib|@grpc[\\/]grpc-js)' },
    },
    {
      name: 'testing-no-inbound-adapters',
      comment: 'Plan §3.3: el subpath /testing no arrastra inbound/adapters (Nest/swagger).',
      severity: 'error',
      from: { path: '^src/testing/' },
      to: { path: '^src/(inbound|adapters)[\\/]' },
    },
    {
      name: 'saga-postgres-no-npm',
      comment:
        'Spec SAGA_CONCURRENCY sec.3: the Postgres saga adapters take a query function from the app ' +
        'and import no npm package, so the main barrel can export them.',
      severity: 'error',
      from: { path: '^src/saga/postgres/' },
      to: {
        dependencyTypes: [
          'npm',
          'npm-dev',
          'npm-optional',
          'npm-peer',
          'npm-no-pkg',
          'npm-unknown',
        ],
      },
    },
    {
      name: 'src-no-pg',
      comment: 'pg is a devDependency for the gated integration tests only; src never imports it.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: 'node_modules[\\/](pg|pg-[^\\/]+|@types[\\/]pg)[\\/]' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.js', '.mjs'],
    },
  },
};
