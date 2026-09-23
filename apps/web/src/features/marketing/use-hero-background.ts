import { useEffect, useState } from 'react';

/**
 * An optional background image for the hero.
 *
 * Looks for a file in `public/hero/`. If one is there it is used; if not, the
 * hero keeps its CSS gradient and nothing looks broken. Same rule as the APK
 * card and the demo video: show what is actually published, never a placeholder
 * or a link to something that is not there.
 *
 * Several extensions are tried in order rather than forcing one, because
 * whoever drops the file in should not have to convert it first. WebP is
 * preferred where it exists — it is typically half the size of the same JPEG,
 * and a hero image is the largest thing on the page.
 *
 * Probed with `Image()` rather than `fetch`, so a hit is already decoded and in
 * the browser cache by the time it is rendered. Fetching first would download
 * it twice.
 */

const CANDIDATES = [
  '/hero/background.webp',
  '/hero/background.jpg',
  '/hero/background.jpeg',
  '/hero/background.png',
];

/** Resolved once per page load, not once per component. */
let resolved: string | null | undefined;
let probing: Promise<string | null> | null = null;

function probe(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = src;
  });
}

async function findBackground(): Promise<string | null> {
  for (const candidate of CANDIDATES) {
    if (await probe(candidate)) return candidate;
  }
  return null;
}

export function useHeroBackground(): string | null {
  const [src, setSrc] = useState<string | null>(resolved ?? null);

  useEffect(() => {
    // Already settled this page load, including a settled "there isn't one".
    if (resolved !== undefined) {
      setSrc(resolved);
      return undefined;
    }

    let cancelled = false;
    probing ??= findBackground();

    void probing.then((found) => {
      resolved = found;
      if (!cancelled) setSrc(found);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return src;
}
