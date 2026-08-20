/** Unit tests: fast, no database, Prisma mocked. */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.spec.json' }] },
  collectCoverageFrom: ['**/*.ts', '!**/generated/**', '!**/*.module.ts', '!main.ts', '!worker.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: { '^@idea001/api-types$': '<rootDir>/../../../packages/api-types/src/index.ts' },

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
