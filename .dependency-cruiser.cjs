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
      comment:
        'Spec §15 / plan §4.2: el barrel público jamás arrastra amqplib o @grpc/grpc-js.',
      severity: 'error',
      from: { path: '^src/index\\.ts$' },
      to: { path: 'node_modules[\\/](amqplib|@grpc[\\/]grpc-js)' },
    },
    {
      name: 'testing-no-inbound-adapters',
      comment:
        'Plan §3.3: el subpath /testing no arrastra inbound/adapters (Nest/swagger).',
      severity: 'error',
      from: { path: '^src/testing/' },
      to: { path: '^src/(inbound|adapters)[\\/]' },
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
