import { formatApkDate, formatApkSize, useApkManifest } from '../../lib/use-apk-manifest';

/**
 * The Android download offer on the home page.
 *
 * Everything shown is read from `leadflow-apk.json`, which
 * `scripts/publish-apk.mjs` writes from the real Gradle output. Nothing here is
 * hardcoded — not the version, not the size, not the date — because a download
 * card that claims a version the file does not have is worse than no card.
 *
 * If the manifest is missing, this renders NOTHING. A deployment that has not
 * published an APK shows no download button rather than a link that 404s.
 *
 * Settings carries the same offer for people who are already signed in, since
 * a signed-in visitor to `/` never sees this page. Both read one manifest
 * through one hook, so they cannot disagree.
 */
export function AndroidDownload(): React.JSX.Element | null {
  const manifest = useApkManifest();

  if (!manifest) return null;

  return (
    <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="mb-2 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
              <span aria-hidden="true">📱</span> Android
            </p>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
              LeadFlow for Android
            </h2>
            <p className="mt-2 max-w-xl text-sm text-pretty text-slate-600">
              The same LeadFlow, on your phone. Install it directly — it is not on the Play
              Store, so Android will ask you to allow installation from this source.
            </p>

            {/* Real build facts, read from the published manifest. */}
            <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-500">
              {manifest.versionName && (
                <div>
                  <dt className="inline font-medium text-slate-700">Version </dt>
                  <dd className="inline">
                    {manifest.versionName}
                    {manifest.versionCode !== null && ` (${manifest.versionCode})`}
                  </dd>
                </div>
              )}
              <div>
                <dt className="inline font-medium text-slate-700">Size </dt>
                <dd className="inline">{formatApkSize(manifest.bytes)}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-slate-700">Built </dt>
                <dd className="inline">{formatApkDate(manifest.builtAt)}</dd>
              </div>
              {/*
                * The build type is stated plainly. A debug APK is signed with
                * the shared debug key and cannot be upgraded in place by a
                * release build later — worth knowing before installing.
                */}
              <div>
                <dt className="inline font-medium text-slate-700">Build </dt>
                <dd className="inline capitalize">{manifest.variant}</dd>
              </div>
            </dl>
          </div>

          <div className="shrink-0">
            <a
              href={manifest.url}
              download={manifest.fileName}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-6 py-3 text-sm font-medium text-white transition hover:bg-slate-800 sm:w-auto"
            >
              <span aria-hidden="true">⬇</span> Download APK
            </a>
          </div>
        </div>

        {/*
          * The checksum, so somebody can verify the file arrived intact. Shown
          * rather than hidden because an APK installed outside the Play Store
          * has no other integrity signal.
          */}
        <p className="mt-5 border-t border-slate-100 pt-4 font-mono text-[11px] break-all text-slate-400">
          SHA-256 {manifest.sha256}
        </p>
      </div>
    </section>
  );
}
