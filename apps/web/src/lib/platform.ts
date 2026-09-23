import type { SecureStorage as SecureStorageType } from '@aparajita/capacitor-secure-storage';

/**
 * Where the app is running, and what that changes.
 *
 * Exactly two things differ between a browser tab and the Android APK, and
 * both are forced by the WebView rather than chosen:
 *
 *   1. **The API origin.** A browser is served from the same origin as the API
 *      (or proxied to it in development), so a relative `/api/v1` works. A
 *      Capacitor WebView is served from `https://localhost` — its own bundled
 *      assets — so a relative URL would resolve to the APK itself. It needs an
 *      absolute URL, and that URL differs per developer machine, so it comes
 *      from configuration and never from source.
 *
 *   2. **Where the refresh token lives.** The web keeps it in an httpOnly,
 *      `SameSite=Strict` cookie, which is the strongest option available and
 *      is unchanged. That cookie cannot cross from `https://localhost` to an
 *      API on another origin, and making it able to — `SameSite=None` — would
 *      weaken CSRF protection for every browser user to serve the APK. So the
 *      APK uses the token-in-body path the API has supported since Phase 1
 *      (`platform: 'ANDROID'`) and stores the token itself.
 *
 * Everything else — screens, API client, hooks, business logic — is shared.
 */

/**
 * Whether this bundle is running inside the Android app.
 *
 * Read from the global Capacitor injects, not from the user agent: a user
 * agent can be spoofed and is not a reliable statement about the runtime.
 * Absent in a browser and in tests, which is what makes the browser path the
 * default rather than something that must be opted into.
 */
export function isNativeApp(): boolean {
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

/** What the login and refresh endpoints are told. Decides cookie vs body. */
export function clientPlatform(): 'WEB' | 'ANDROID' {
  return isNativeApp() ? 'ANDROID' : 'WEB';
}

/**
 * The API root.
 *
 * Relative in a browser, so the Vite proxy in development and same-origin
 * hosting in production both keep working exactly as they do today.
 *
 * Absolute in the APK, from `VITE_API_BASE_URL`, which is baked in at build
 * time. It is a public address, not a secret: an API URL is discoverable by
 * anyone who runs the app. No credential is ever compiled in.
 */
export function apiBaseUrl(): string {
  const configured = import.meta.env['VITE_API_BASE_URL'] as string | undefined;

  if (isNativeApp()) {
    if (!configured) {
      /*
       * Deliberately loud, and deliberately not a guess.
       *
       * There is no sensible fallback: `localhost` inside the WebView is the
       * APK, `10.0.2.2` is emulator-only, and a LAN IP belongs to one machine.
       * A wrong guess produces an app that fails every request with a confusing
       * network error, which is far harder to diagnose than this message.
       */
      throw new Error(
        'VITE_API_BASE_URL must be set when building the Android app. ' +
          'See docs/android.md.',
      );
    }
    return `${configured.replace(/\/+$/, '')}/api/v1`;
  }

  // A browser build MAY set it (for a separately hosted API) but normally
  // does not, and the relative path is what keeps the refresh cookie
  // same-origin.
  return configured ? `${configured.replace(/\/+$/, '')}/api/v1` : '/api/v1';
}

/**
 * The refresh token, when this client is the one holding it.
 *
 * Android only. On the web this is never called: the token sits in a cookie the
 * browser attaches and this code cannot read, which is the stronger position
 * and stays the default.
 *
 * Stored in Android's `EncryptedSharedPreferences` rather than `localStorage`.
 *
 * WHAT THAT DOES AND DOES NOT FIX, stated plainly because the distinction is
 * easy to get wrong:
 *
 *   It DOES protect a token at rest. A lost, stolen or rooted handset, an ADB
 *   backup, another app reading shared storage — in every one of those the
 *   value is now ciphertext keyed to the device keystore. For a phone carried
 *   around a market or a warehouse that is the realistic threat.
 *
 *   It does NOT stop cross-site scripting. Script running inside the WebView
 *   holds the app's own bridge privileges, so it can call this plugin and read
 *   the value back exactly as it could read localStorage. Nothing reachable
 *   from JavaScript can defend against JavaScript.
 *
 * What actually contains that second risk is elsewhere and already in place:
 * the bundle is local to the APK with no remote script origin, the CSP admits
 * no third-party script, and refresh rotation with reuse detection means a
 * stolen token is single-use and its theft is detectable.
 */
const REFRESH_KEY = 'leadflow.refresh';

/**
 * The synchronous view of the token.
 *
 * Native secure storage is asynchronous; `readStoredRefreshToken` is called
 * from the middle of a request-retry path that cannot await. So the durable
 * store is encrypted and this cache is what callers read — hydrated once at
 * startup, written through on every change.
 *
 * Memory-only, and deliberately: a copy that outlives the process would defeat
 * the point of encrypting the durable one.
 */
let cachedRefreshToken: string | null = null;

type SecureStorage = typeof SecureStorageType;

/*
 * Wrapped in an object, and that is load-bearing rather than stylistic.
 *
 * A Capacitor plugin is a Proxy that forwards ANY property access to a native
 * call — including `.then`. Returning it straight out of an async function
 * makes JavaScript treat it as a thenable and invoke `then()`, which the
 * bridge forwards to a method no platform implements; the promise then never
 * settles and every caller hangs. Boxing it means the await sees a plain
 * object.
 */
async function secureStorage(): Promise<{ storage: SecureStorage } | null> {
  if (!isNativeApp()) return null;

  try {
    const module = await import('@aparajita/capacitor-secure-storage');
    return { storage: module.SecureStorage };
  } catch {
    // Absent in a browser build. Not an error — the web path never stores a
    // token in the first place.
    return null;
  }
}

/**
 * Loads the stored token into memory. Call once, before restoring a session.
 *
 * Returns whether a token was found, so the caller can skip a restore attempt
 * that has nothing to restore from.
 */
export async function hydrateRefreshToken(): Promise<boolean> {
  const box = await secureStorage();
  if (!box) return false;

  try {
    const value = await box.storage.get(REFRESH_KEY);
    cachedRefreshToken = typeof value === 'string' ? value : null;
  } catch {
    // A missing or unreadable token means "sign in again", which is correct
    // and safe. A keystore that has been invalidated — by a factory reset or a
    // changed screen lock — lands here too.
    cachedRefreshToken = null;
  }

  return cachedRefreshToken !== null;
}

export function readStoredRefreshToken(): string | null {
  if (!isNativeApp()) return null;
  return cachedRefreshToken;
}

export function storeRefreshToken(token: string | null): void {
  if (!isNativeApp()) return;

  // The cache updates synchronously so the very next read is correct even
  // though the durable write is still in flight.
  cachedRefreshToken = token;

  void (async () => {
    const box = await secureStorage();
    if (!box) return;

    try {
      if (token) await box.storage.set(REFRESH_KEY, token);
      else await box.storage.remove(REFRESH_KEY);
    } catch {
      // Not fatal. The session still works from the cache until the access
      // token expires; the cost is having to sign in again after a restart.
    }
  })();
}
