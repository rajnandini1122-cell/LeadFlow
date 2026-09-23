import { Card, CardHeader } from '../../components/ui';
import { formatApkDate, formatApkSize, useApkManifest } from '../../lib/use-apk-manifest';

/**
 * The Android app, offered from inside the product.
 *
 * The marketing page carries the same offer, but a signed-in visitor to `/` is
 * redirected to their dashboard — so that card is only ever seen while signed
 * out, which is the wrong moment to learn the phone app exists. Somebody who is
 * already using LeadFlow and wants it on their phone looks in Settings.
 *
 * Same manifest, same numbers, no duplicated facts. Renders nothing when no APK
 * has been published.
 */
export function AndroidDownloadCard(): React.JSX.Element | null {
  const manifest = useApkManifest();

  if (!manifest) return null;

  return (
    <Card>
      <CardHeader title="LeadFlow for Android" />
      <div className="space-y-4 p-5">
        <p className="text-sm text-pretty text-slate-600">
          Install LeadFlow on your phone. It is not on the Play Store, so Android will ask you
          to allow installation from this source.
        </p>

        {/* Real build facts, read from the published artifact. */}
        <dl className="space-y-1.5 text-xs text-slate-500">
          {manifest.versionName && (
            <div className="flex justify-between gap-3">
              <dt>Version</dt>
              <dd className="font-medium text-slate-700">
                {manifest.versionName}
                {manifest.versionCode !== null && ` (${manifest.versionCode})`}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt>Size</dt>
            <dd className="font-medium text-slate-700">{formatApkSize(manifest.bytes)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Built</dt>
            <dd className="font-medium text-slate-700">{formatApkDate(manifest.builtAt)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Build type</dt>
            {/*
              * Stated plainly. A debug APK is signed with the shared debug key
              * and cannot be upgraded in place by a release build later.
              */}
            <dd className="font-medium text-slate-700 capitalize">{manifest.variant}</dd>
          </div>
        </dl>

        <a
          href={manifest.url}
          download={manifest.fileName}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
        >
          <span aria-hidden="true">⬇</span> Download APK
        </a>

        <p className="font-mono text-[10px] break-all text-slate-400">
          SHA-256 {manifest.sha256}
        </p>
      </div>
    </Card>
  );
}
