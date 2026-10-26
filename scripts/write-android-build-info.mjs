#!/usr/bin/env node
/**
 * Records, inside the Android app's assets, what the APK was built from.
 *
 * Nobody could say which source the 2026-08-22 APK came from, or which API it
 * talked to — it turned out to be none. This file answers both, for every APK
 * from now on: it travels inside the APK (Capacitor packages `assets/public/`)
 * and `publish-apk.mjs` reads it back and refuses an APK that points nowhere.
 *
 * Run after `cap sync`, which replaces the assets folder. Written ONLY into the
 * Android assets, never into `dist/`, so the website does not serve it.
 *
 * Nothing secret: an API origin and a commit hash.
 */
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'apps/web/android/app/src/main/assets/public');

if (!existsSync(assets)) {
  console.error(`No Android assets at ${assets} — run \`cap sync android\` first.`);
  process.exit(1);
}

const git = (args) => {
  try {
    return execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const url = process.env.VITE_API_BASE_URL ?? null;
let apiOrigin = null;
try {
  apiOrigin = url ? new URL(url).origin : null;
} catch {
  apiOrigin = null;
}

const info = {
  apiOrigin,
  sourceCommit: git('rev-parse HEAD'),
  sourceBranch: git('rev-parse --abbrev-ref HEAD'),
  // Uncommitted changes mean the commit alone does not reproduce this APK.
  sourceDirty: (git('status --porcelain') ?? '').length > 0,
  builtAt: new Date().toISOString(),
};

writeFileSync(join(assets, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`Android build info: ${info.sourceCommit?.slice(0, 7) ?? 'unknown'}${info.sourceDirty ? ' (dirty)' : ''} → ${apiOrigin ?? 'NO API'}`);
