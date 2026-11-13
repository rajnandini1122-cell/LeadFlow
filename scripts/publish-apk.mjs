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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * The download page is for customers, so a RELEASE build is the default and
 * the only thing published unless --debug AND --allow-debug are both given
 * (a local development server only). --dry-run checks everything and copies
 * nothing; --apk <path> checks a specific file instead of Gradle's output.
 */
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const variant = process.argv.includes('--debug') ? 'debug' : 'release';
const dryRun = process.argv.includes('--dry-run');
const apkDir = join(root, 'apps/web/android/app/build/outputs/apk', variant);
const apkPath = arg('--apk') ?? join(apkDir, `app-${variant}.apk`);

/** The certificate LeadFlow 1.3.0 (code 4) was signed with. Every update must match it. */
const RELEASE_CERT_SHA256 = '9a0ec3ed97dd17f4e2955532429f7433ee581cfda48655f565351e9b00dda6a1';
const APPLICATION_ID = 'app.leadflow.crm';
const metadataPath = join(apkDir, 'output-metadata.json');

if (!existsSync(apkPath)) {
  console.error(`No APK at ${apkPath}`);
  console.error(
    `Build one first:  npm run android:${variant === 'release' ? 'release' : 'build'} -w apps/web`,
  );
  process.exit(1);
}

const outDir = join(root, 'apps/web/public/downloads');
mkdirSync(outDir, { recursive: true });
const manifestPath = join(outDir, 'leadflow-apk.json');

/*
 * Refuse to publish an APK that cannot work, or that cannot replace the one
 * people already have. All of this is checked BEFORE anything is copied.
 *
 * The APK published on 2026-08-22 had no API address compiled in: it
 * installed, opened and failed every request. `build-info.json` is written into
 * the app's assets by `android:sync` and packaged into the APK; publishing now
 * requires it, and requires it to name a reachable API.
 */
const refusals = [];
const buildInfoPath = join(root, 'apps/web/android/app/src/main/assets/public/build-info.json');
const buildInfo = existsSync(buildInfoPath)
  ? JSON.parse(readFileSync(buildInfoPath, 'utf8'))
  : null;

if (!buildInfo) {
  refusals.push('No build-info.json in the Android assets — build with `npm run android:build`.');
} else {
  if (!buildInfo.apiOrigin)
    refusals.push('The APK has no API address compiled in (VITE_API_BASE_URL was unset).');
  const host = buildInfo.apiOrigin ? new URL(buildInfo.apiOrigin).hostname : '';
  if (
    ['localhost', '127.0.0.1', '0.0.0.0', '10.0.2.2', '[::1]'].includes(host) &&
    !process.argv.includes('--allow-local')
  ) {
    refusals.push(
      `The APK points at ${host}, which only works on the build machine. Pass --allow-local if that is intended.`,
    );
  }
  // The assets must predate the APK, or the APK was built from older assets.
  if (Date.parse(buildInfo.builtAt) > statSync(apkPath).mtimeMs) {
    refusals.push(
      'build-info.json is newer than the APK — the APK was not built from these assets. Rebuild.',
    );
  }
}

/*
 * What the APK FILE says — its package, version and signer — read with the
 * Android SDK's own tools. Gradle's metadata describes the last build, which is
 * not necessarily this file.
 */
const tools = buildTools();
let apk = { applicationId: null, versionName: null, versionCode: null };
if (!tools) {
  refusals.push(
    'Android SDK build-tools (aapt2, apksigner) not found; set ANDROID_HOME. Nothing can be verified.',
  );
} else {
  apk = badging(tools.aapt2, apkPath);
  if (apk.applicationId !== APPLICATION_ID) {
    refusals.push(
      `The APK's package is ${apk.applicationId ?? 'unreadable'}, not ${APPLICATION_ID}.`,
    );
  }
  if (variant === 'release') {
    const signer = signerOf(tools.apksigner, apkPath);
    if (!signer.ok) {
      refusals.push(
        `The APK does not verify as signed (${signer.reason}). An unsigned APK is never published.`,
      );
    } else if (signer.sha256 !== RELEASE_CERT_SHA256) {
      refusals.push(
        `The APK is signed with certificate ${signer.sha256}, not LeadFlow's release certificate ${RELEASE_CERT_SHA256}. Phones would refuse it as an update.`,
      );
    }
    const published = join(outDir, 'leadflow.apk');
    if (existsSync(published)) {
      const current = signerOf(tools.apksigner, published);
      if (current.ok && current.sha256 !== RELEASE_CERT_SHA256) {
        refusals.push(
          `The currently published APK has an unexpected certificate (${current.sha256}); stop and investigate.`,
        );
      }
    }
    if (buildInfo?.sourceDirty) {
      refusals.push('The APK was built from uncommitted changes. Commit, then rebuild.');
    }
  } else if (!process.argv.includes('--allow-debug')) {
    refusals.push(
      'A debug APK is signed with a development key and is never published to the download page. (--allow-debug for a local development server only.)',
    );
  }
}

// Android installs an update only if its versionCode is higher.
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const builtCode = apk.versionCode;
const metadataCode = existsSync(metadataPath)
  ? (JSON.parse(readFileSync(metadataPath, 'utf8')).elements?.[0]?.versionCode ?? null)
  : null;
if (!arg('--apk') && metadataCode !== null && builtCode !== null && metadataCode !== builtCode) {
  refusals.push(
    `The APK file is versionCode ${builtCode} but Gradle's last build was ${metadataCode}: a stale file. Rebuild.`,
  );
}
if (previous?.versionCode != null && (builtCode === null || builtCode <= previous.versionCode)) {
  refusals.push(
    `versionCode ${builtCode ?? 'unknown'} is not higher than the published ${previous.versionCode}; ` +
      'phones would refuse it as an update. Bump versionCode in android/app/build.gradle.',
  );
}

if (refusals.length > 0) {
  console.error('\nPublish refused — nothing was copied:\n');
  for (const refusal of refusals) console.error(`  • ${refusal}`);
  console.error('');
  process.exit(1);
}

if (dryRun) {
  console.log(
    `Dry run: ${apkPath} would be published — ${apk.applicationId} ${apk.versionName} (code ${apk.versionCode}), ${variant}, certificate OK. Nothing copied.`,
  );
  process.exit(0);
}

const fileName = 'leadflow.apk';
copyFileSync(apkPath, join(outDir, fileName));

const bytes = statSync(apkPath).size;
const sha256 = createHash('sha256').update(readFileSync(apkPath)).digest('hex');

// What the published file itself is, read with aapt2 above.
const { applicationId, versionName, versionCode } = apk;

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
  // Which source and which API this APK is — answerable for every APK now.
  apiOrigin: buildInfo.apiOrigin,
  sourceCommit: buildInfo.sourceCommit,
  sourceDirty: buildInfo.sourceDirty,
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Published ${fileName}`);
console.log(`  variant     ${variant}`);
console.log(`  version     ${versionName ?? 'unknown'} (code ${versionCode ?? 'unknown'})`);
console.log(`  size        ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  sha256      ${sha256}`);
console.log(`  api         ${buildInfo.apiOrigin}`);
console.log(
  `  source      ${buildInfo.sourceCommit ?? 'unknown'}${buildInfo.sourceDirty ? ' (uncommitted changes)' : ''}`,
);
console.log(`  served at   /downloads/${fileName}`);

/** The newest build-tools with aapt2 and apksigner, from ANDROID_HOME, ANDROID_SDK_ROOT or the default SDK. */
function buildTools() {
  const sdk = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ]
    .filter(Boolean)
    .find((p) => existsSync(join(p, 'build-tools')));
  if (!sdk) return null;
  const win = process.platform === 'win32';
  const versions = readdirSync(join(sdk, 'build-tools')).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  );
  for (const v of versions) {
    const dir = join(sdk, 'build-tools', v);
    const aapt2 = join(dir, win ? 'aapt2.exe' : 'aapt2');
    const apksigner = join(dir, win ? 'apksigner.bat' : 'apksigner');
    if (existsSync(aapt2) && existsSync(apksigner)) return { aapt2, apksigner };
  }
  return null;
}

/** package, versionCode and versionName as recorded in the APK's manifest. */
function badging(aapt2, file) {
  const r = spawnSync(aapt2, ['dump', 'badging', file], { encoding: 'utf8' });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('package:')) ?? '';
  const field = (name) => new RegExp(`${name}='([^']*)'`).exec(line)?.[1] ?? null;
  const code = field('versionCode');
  return {
    applicationId: field('name'),
    versionName: field('versionName'),
    versionCode: code === null ? null : Number(code),
  };
}

/** Verifies the APK signature and returns the single signer's certificate SHA-256. */
function signerOf(apksigner, file) {
  const r = spawnSync(`"${apksigner}"`, ['verify', '--print-certs', `"${file}"`], {
    encoding: 'utf8',
    shell: true,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      reason: (r.stderr || r.stdout || 'verification failed').trim().split('\n')[0],
    };
  }
  const digests = [
    ...(r.stdout ?? '').matchAll(/Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})/g),
  ].map((m) => m[1]);
  if (digests.length !== 1) {
    return { ok: false, reason: `expected exactly one signer, found ${digests.length}` };
  }
  return { ok: true, sha256: digests[0] };
}
