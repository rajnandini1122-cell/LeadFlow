import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      // Resolve the shared package to its TypeScript SOURCE, not its build.
      //
      // packages/api-types compiles to CommonJS for the NestJS API. The Vite
      // dev server loads dependencies as native ES modules, and an ESM import
      // cannot read named exports out of a CJS file — it fails at runtime with
      // "does not provide an export named 'PERMISSIONS'".
      //
      // `vite build` hides this, because Rollup converts CJS during bundling.
      // So the production build succeeds while `npm run dev` shows a blank
      // page. Pointing at the source fixes both, mirrors the path mapping
      // already in tsconfig.json, removes the need to build api-types before
      // starting the dev server, and gives HMR on shared types.
      '@idea001/api-types': fileURLToPath(
        new URL('../../packages/api-types/src/index.ts', import.meta.url),
      ),
    },
  },

  server: {
    port: 5173,
    proxy: {
      // Same-origin in development so the httpOnly refresh cookie is sent
      // without needing SameSite=None, which would weaken CSRF protection.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },

  build: { outDir: 'dist', sourcemap: true },
});
