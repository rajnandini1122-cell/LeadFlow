import { useEffect, useState } from 'react';
import { api } from './api-client';

/**
 * An image behind an authenticated endpoint.
 *
 * `<img src="...">` cannot carry an Authorization header, and the access token
 * deliberately lives in memory rather than a cookie — so a protected image
 * cannot simply be pointed at. It has to be fetched by code that can attach the
 * token, then handed to the browser as an object URL.
 *
 * The alternatives were both worse. Making the endpoint cookie-authenticated
 * would mean widening the refresh cookie's path, which exists narrow on
 * purpose; making it public behind an unguessable URL would mean a photograph
 * of a customer's staff being readable by anyone who ever saw the link.
 *
 * Results are cached module-wide and keyed on the URL. The URL carries a
 * version that changes whenever the picture does, so the cache invalidates
 * itself and a list of twenty colleagues fetches each face once rather than
 * once per row.
 */

/** url -> object URL, or a promise for one still in flight. */
const cache = new Map<string, string | Promise<string | null> | null>();

async function load(url: string): Promise<string | null> {
  try {
    const response = await api.get<Blob>(url, { responseType: 'blob' });
    return URL.createObjectURL(response.data);
  } catch {
    /*
     * Null, not a throw. A missing or forbidden picture is not an error worth
     * surfacing — the caller falls back to initials, which is a perfectly good
     * avatar and what every user without a photograph already sees.
     */
    return null;
  }
}

export function useAuthedImage(url: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(() => {
    if (!url) return null;
    const cached = cache.get(url);
    return typeof cached === 'string' ? cached : null;
  });

  useEffect(() => {
    if (!url) {
      setSrc(null);
      return undefined;
    }

    let cancelled = false;
    const cached = cache.get(url);

    // Already resolved, including a cached failure.
    if (cached === null) {
      setSrc(null);
      return undefined;
    }
    if (typeof cached === 'string') {
      setSrc(cached);
      return undefined;
    }

    /*
     * One request per URL, even when several components ask at once.
     *
     * The promise itself goes in the cache, so a team list rendering twenty
     * rows that share an avatar issues one fetch rather than twenty.
     */
    const pending = cached ?? load(url);
    cache.set(url, pending);

    void pending.then((objectUrl) => {
      cache.set(url, objectUrl);
      if (!cancelled) setSrc(objectUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return src;
}

/**
 * Drops a cached image so the next render refetches it.
 *
 * Needed after somebody replaces their own picture: the URL changes, so the
 * new one is fetched anyway, but the old object URL would otherwise be held
 * for the life of the page.
 */
export function forgetAuthedImage(url: string | null | undefined): void {
  if (!url) return;
  const cached = cache.get(url);
  if (typeof cached === 'string') URL.revokeObjectURL(cached);
  cache.delete(url);
}
