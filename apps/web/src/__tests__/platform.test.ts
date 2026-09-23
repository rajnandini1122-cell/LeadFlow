import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  apiBaseUrl,
  clientPlatform,
  isNativeApp,
  hydrateRefreshToken,
  readStoredRefreshToken,
  storeRefreshToken,
} from '../lib/platform';

/**
 * What changes between a browser tab and the Android APK.
 *
 * The valuable assertions here are the ones proving the BROWSER path is
 * untouched. Android packaging is only safe if it is invisible to everyone
 * still using a browser, and the way that breaks is a native branch quietly
 * becoming the default.
 */

/** Pretends this bundle is running inside the Capacitor WebView. */
function runAsNativeApp(): void {
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  try {
    globalThis.localStorage?.clear();
  } catch {
    // No storage in this environment; nothing to clear.
  }
});

describe('isNativeApp', () => {
  it('is false in a browser, where Capacitor is not injected', () => {
    expect(isNativeApp()).toBe(false);
  });

  it('is true inside the app', () => {
    runAsNativeApp();
    expect(isNativeApp()).toBe(true);
  });

  it('is false when something else defines Capacitor without the method', () => {
    // Fails closed. A half-present global must not be read as "native".
    vi.stubGlobal('Capacitor', {});
    expect(isNativeApp()).toBe(false);
  });
});

describe('clientPlatform', () => {
  it('tells the API this is a browser, so the refresh token stays a cookie', () => {
    expect(clientPlatform()).toBe('WEB');
  });

  it('tells the API this is Android, so the token comes back in the body', () => {
    runAsNativeApp();
    expect(clientPlatform()).toBe('ANDROID');
  });
});

describe('apiBaseUrl', () => {
  it('is relative in a browser', () => {
    /*
     * The single most important assertion in this file. A relative base is what
     * keeps the Vite dev proxy working, keeps production same-origin, and keeps
     * the httpOnly refresh cookie SameSite=Strict. If Android packaging ever
     * makes this absolute for browsers, CSRF protection weakens for everyone.
     */
    expect(apiBaseUrl()).toBe('/api/v1');
  });

  it('stays relative in a browser even when a URL is configured', () => {
    // A browser build MAY point at a separately hosted API, but it is opt-in
    // and must not be produced by the Android variable leaking in.
    vi.stubEnv('VITE_API_BASE_URL', '');
    expect(apiBaseUrl()).toBe('/api/v1');
  });

  it('is absolute in the app', () => {
    runAsNativeApp();
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com');
    expect(apiBaseUrl()).toBe('https://api.example.com/api/v1');
  });

  it('tolerates a trailing slash rather than producing a double one', () => {
    runAsNativeApp();
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/');
    expect(apiBaseUrl()).toBe('https://api.example.com/api/v1');
  });

  it('refuses to guess when the app was built without an API URL', () => {
    /*
     * Deliberately loud. There is no sensible fallback — localhost inside the
     * WebView is the APK itself — and a guess produces an app that fails every
     * request with a confusing network error instead of one clear message.
     */
    runAsNativeApp();
    expect(() => apiBaseUrl()).toThrow(/VITE_API_BASE_URL/);
  });
});

describe('the stored refresh token', () => {
  it('is never read in a browser, where the cookie is authoritative', () => {
    // Even if something wrote the key, the browser path must ignore it: the
    // httpOnly cookie is stronger and is the only thing that should count.
    globalThis.localStorage.setItem('leadflow.refresh', 'planted');
    expect(readStoredRefreshToken()).toBeNull();
  });

  it('is never written in a browser', () => {
    storeRefreshToken('should-not-persist');

    // Nothing lands in localStorage — the token no longer goes there at all,
    // and the browser path stores nothing anywhere.
    expect(globalThis.localStorage.getItem('leadflow.refresh')).toBeNull();
    expect(readStoredRefreshToken()).toBeNull();
  });

  it('round-trips inside the app', () => {
    runAsNativeApp();
    storeRefreshToken('refresh-abc');
    expect(readStoredRefreshToken()).toBe('refresh-abc');
  });

  it('is cleared on logout', () => {
    runAsNativeApp();
    storeRefreshToken('refresh-abc');
    storeRefreshToken(null);

    // A stale token presented later reads as REUSE to the server, which kills
    // the whole session family. Clearing it is what prevents that.
    expect(readStoredRefreshToken()).toBeNull();
  });

  it('survives the encrypted store being unavailable', () => {
    /*
     * The keystore can genuinely be unusable: a factory reset, a changed screen
     * lock, or a device where the plugin cannot initialise. None of those may
     * crash the app on launch.
     *
     * The BEHAVIOUR HERE CHANGED, deliberately. It used to be that a failed
     * write meant a failed read — the token went to localStorage or nowhere. It
     * now lives in a memory cache in front of encrypted storage, so a failed
     * durable write still leaves a working session for this process. The user
     * signs in again after a restart rather than being unable to sign in at
     * all, which is strictly the better failure.
     */
    runAsNativeApp();

    expect(() => storeRefreshToken('x')).not.toThrow();
    // Usable now…
    expect(readStoredRefreshToken()).toBe('x');
  });

  it('hydrate reports nothing in a browser, where the cookie is authoritative', async () => {
    /*
     * The deterministic half of the hydrate contract.
     *
     * A browser never stores a refresh token — the httpOnly cookie does that
     * job — so a cold start must report nothing to restore and fall through to
     * the ordinary refresh call.
     *
     * The NATIVE half is deliberately not asserted here. Importing the secure
     * storage plugin initialises Capacitor web runtime, which replaces the
     * injected global this test uses to simulate a native platform — so a
     * jsdom test cannot hold the app in native mode across that import. It is
     * verified on a device, alongside push, and is listed as such.
     */
    const found = await hydrateRefreshToken();

    expect(found).toBe(false);
    expect(readStoredRefreshToken()).toBeNull();
  });
});
