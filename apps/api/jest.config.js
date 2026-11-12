/** Unit tests: fast, no database, Prisma mocked. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }],
    // sanitize-html's HTML parser ships as ES modules only. Node loads them
    // natively (require(esm), Node >= 22.12); Jest's module system does not,
    // so these few packages — and nothing else — are transpiled for tests.
    'node_modules[\\\\/].+\\.js$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.esm-deps.json' }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(sanitize-html/node_modules/)?(htmlparser2|domhandler|domutils|dom-serializer|domelementtype|entities)/)',
  ],
  collectCoverageFrom: ['**/*.ts', '!**/generated/**', '!**/*.module.ts', '!main.ts', '!worker.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@idea001/api-types$': '<rootDir>/../../../packages/api-types/src/index.ts',
  },

  // The tenancy layer is the one place where a regression is a data breach
  // rather than a bug, so it carries a hard coverage floor.
  coverageThreshold: {
    './common/prisma/tenant-scope.extension.ts': {
      statements: 95,
      branches: 90,
      functions: 95,
      lines: 95,
    },
    './common/tenancy/tenant-context.service.ts': {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
  },
};
