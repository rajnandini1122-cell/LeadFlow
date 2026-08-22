#!/usr/bin/env node
/**
 * Removes the published APK from the web bundle before it is packaged.
 *
 * `apps/web/public/downloads/` holds the APK the download page offers, and Vite
 * copies `public/` into `dist/` verbatim. Capacitor then copies the whole of
 * `dist/` into the Android app's assets — so without this, each build packages
 * the PREVIOUS APK inside the new one. The artifact doubles in size, and doing
 * it twice would double it again.
 *
 * Run between `vite build` and `cap sync`. It only touches the bundle copy in
 * `dist/`; the source in `public/` is untouched, so the browser download is
 * unaffected and the next `vite build` restores it.
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = join(root, 'apps/web/dist/downloads');

if (existsSync(bundled)) {
  rmSync(bundled, { recursive: true, force: true });
  console.log('Removed dist/downloads from the bundle (the APK must not ship inside itself).');
} else {
  console.log('No dist/downloads to remove.');
}
