// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/generated/**',
      '**/*.config.mjs',
      '**/*.config.js',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Node scripts and config files run outside the TS projects and need the
    // Node globals declared.
    files: ['scripts/**/*.{mjs,js}', '**/*.config.{mjs,js}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', module: 'writable' },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // NestJS and `import type` do not mix.
  //
  // A class that only ever appears as a constructor parameter type LOOKS
  // type-only to this rule, so it would rewrite the import to `import type` —
  // and `import type` is erased at compile time. `emitDecoratorMetadata` would
  // then record `Object` instead of the class in `design:paramtypes`, and Nest's
  // injector would fail to resolve the dependency AT RUNTIME.
  //
  // Running `eslint --fix` with this rule enabled would therefore silently
  // break dependency injection across the API. It stays off here and remains on
  // for the web app, which has no decorators.
  // ---------------------------------------------------------------------------
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // TENANT ISOLATION GUARDRAILS (see docs/tenancy.md)
  //
  // Layer 2 of tenant isolation is a Prisma client extension that injects
  // `organizationId` into every query. It cannot see raw SQL, and it cannot
  // protect code that reaches around the repository layer. These two rules
  // close both gaps at lint time.
  // ---------------------------------------------------------------------------
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/common/prisma/**',
      'apps/api/src/**/*.repository.ts',
      'apps/api/src/**/*.spec.ts',
      // Module files reference PrismaService only to register it as a DI
      // provider. That is wiring, not data access.
      'apps/api/src/**/*.module.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              /*
               * The last entry is a NEGATION, and order matters: it exempts the
               * type-only transaction module from the blanket ban above.
               *
               * The rule exists to stop non-repository code reaching the Prisma
               * CLIENT and escaping tenant scoping. A service that composes
               * several repository writes into one atomic operation has to be
               * able to NAME the transaction it passes between them, and a type
               * alias grants access to nothing. Exempting one file by name is
               * narrower than loosening the rule.
               */
              group: [
                '**/prisma/prisma.service',
                '**/common/prisma/*',
                '!**/common/prisma/transaction',
              ],
              message:
                'Direct Prisma access is only permitted in *.repository.ts files. ' +
                'Go through the repository layer so tenant scoping is applied. See docs/tenancy.md.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name=/^\\$queryRaw|^\\$executeRaw|^\\$queryRawUnsafe|^\\$executeRawUnsafe/]",
          message:
            'Raw SQL bypasses the Prisma tenant-scoping extension. If you genuinely need it, ' +
            'put it in a *.repository.ts, bind organizationId as an explicit parameter, add a ' +
            'case to test/tenant-isolation.e2e-spec.ts, and disable this rule on that line only.',
        },
      ],
    },
  },
);
