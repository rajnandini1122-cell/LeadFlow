/**
 * Minimal TypeScript require hook for child processes spawned by E2E suites.
 *
 * Nest's dependency injection needs decorator metadata (design:paramtypes),
 * which esbuild-based loaders such as tsx do not emit. This transpiles each
 * file with the TypeScript compiler -- per file, like ts-jest does for the
 * suite itself -- using the compiler options from tsconfig.base.json.
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef --
   a CommonJS require hook: it is loaded with `node -r`, before any TypeScript
   support exists, so it can only be plain CommonJS. */
const { readFileSync } = require('node:fs');
const ts = require('typescript');

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2023,
  esModuleInterop: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
};

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions,
    fileName: filename,
  });
  module._compile(outputText, filename);
};
