import { useEffect, useState } from 'react';

/**
 * What the published Android build actually is.
 *
 * Written by `scripts/publish-apk.mjs` from the real Gradle output — the size,
 * hash, versionName and versionCode are read from the artifact, never typed in.
 * Shared by the marketing page and the settings page so the two can never
 * disagree about what is on offer.
 *
 * Returns null when nothing has been published, and every consumer renders
 * nothing in that case: a download button that 404s, or a version that does not
 * match the file behind it, is worse than no download section at all.
 */
export interface ApkManifest {
  fileName: string;
  url: string;
  variant: string;
  applicationId: string | null;
  versionName: string | null;
  versionCode: number | null;
  bytes: number;
  sha256: string;
  builtAt: string;
}

export function useApkManifest(): ApkManifest | null {
  const [manifest, setManifest] = useState<ApkManifest | null>(null);

  useEffect(() => {
    let cancelled = false;

    // A plain fetch of a static file, not an API call: it is public, needs no
    // session, and is reachable from the signed-out marketing page.
    fetch('/downloads/leadflow-apk.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: ApkManifest | null) => {
        // `url` is the one field everything else hangs off. A partial or
        // corrupt manifest is not something to render around.
        if (!cancelled && data?.url) setManifest(data);
      })
      .catch(() => {
        // No manifest, no card. Nothing to tell anyone about.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return manifest;
}

export function formatApkSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatApkDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
