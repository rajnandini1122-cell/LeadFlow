import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// Reuses the real vite config — including the @idea001/api-types alias — so the
// smoke test exercises the SAME module resolution the dev server uses. A test
// with its own resolution would not have caught the CJS/ESM failure that made
// the page render blank.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/__tests__/setup.ts'],
    },
  }),
);
