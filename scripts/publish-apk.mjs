#!/usr/bin/env node
/**
 * Publishes a built APK to the web app's static assets.
 *
 * Copies the artifact Gradle produced into `apps/web/public/downloads/` and
 * writes a manifest beside it describing what is actually there: the real file
 * size, the real hash, the applicationId and versionName Gradle recorded, and
 * the time the file was written.
 *
 * Every value is READ from the build output. Nothing is typed in and nothing is
 * defaulted, because a download page that overstates the version — or offers a
 * file that is not there — is worse than no download page at all. If the APK is
 * missing this exits non-zero and writes nothing, and the page renders no
 * download card.
 *
 * Serving from `public/` is deliberate: Vite copies it into `dist/` verbatim,
 * so the APK is available from the dev server and from whatever hosts the
 * production build, with no new infrastructure to run or secure.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const variant = process.argv.includes('--release') ? 'release' : 'debug';
const apkDir = join(root, 'apps/web/android/app/build/outputs/apk', variant);
const apkPath = join(apkDir, `app-${variant}.apk`);
const metadataPath = join(apkDir, 'output-metadata.json');

if (!existsSync(apkPath)) {
  console.error(`No APK at ${apkPath}`);
  console.error(`Build one first:  npm run android:build${variant === 'release' ? ':release' : ''}`);
  process.exit(1);
}

const outDir = join(root, 'apps/web/public/downloads');
mkdirSync(outDir, { recursive: true });

const fileName = 'leadflow.apk';
copyFileSync(apkPath, join(outDir, fileName));

const bytes = statSync(apkPath).size;
const sha256 = createHash('sha256').update(readFileSync(apkPath)).digest('hex');

// Gradle's own record of what it built. Read rather than assumed.
let applicationId = null;
let versionName = null;
let versionCode = null;

if (existsSync(metadataPath)) {
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  applicationId = metadata.applicationId ?? null;
  const element = metadata.elements?.[0];
  versionName = element?.versionName ?? null;
  versionCode = element?.versionCode ?? null;
}

const manifest = {
  fileName,
  url: `/downloads/${fileName}`,
  variant,
  applicationId,
  versionName,
  versionCode,
  bytes,
  sha256,
  builtAt: statSync(apkPath).mtime.toISOString(),
};

writeFileSync(join(outDir, 'leadflow-apk.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Published ${fileName}`);
console.log(`  variant     ${variant}`);
console.log(`  version     ${versionName ?? 'unknown'} (code ${versionCode ?? 'unknown'})`);
console.log(`  size        ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  sha256      ${sha256}`);
console.log(`  served at   /downloads/${fileName}`);
