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
 * Android only. On the web this is never called: the token is in a cookie the
 * browser attaches and this code cannot read, which is the stronger position
 * and stays the default.
 *
 * `localStorage` inside the WebView is not as strong as Android's
 * `EncryptedSharedPreferences`, and this is an honest trade rather than a
 * claim of equivalence. What makes it acceptable here: the WebView loads a
 * fixed bundle from the APK with no remote script origin and no user-supplied
 * HTML, so the XSS surface a browser tab has is largely absent. Moving to
 * encrypted native storage is a plugin swap behind this function, which is why
 * every caller goes through it.
 */
const REFRESH_KEY = 'leadflow.refresh';

export function readStoredRefreshToken(): string | null {
  if (!isNativeApp()) return null;
  try {
    return globalThis.localStorage?.getItem(REFRESH_KEY) ?? null;
  } catch {
    // Storage can be unavailable or throw. A missing token means "sign in
    // again", which is correct and safe.
    return null;
  }
}

export function storeRefreshToken(token: string | null): void {
  if (!isNativeApp()) return;
  try {
    if (token) globalThis.localStorage?.setItem(REFRESH_KEY, token);
    else globalThis.localStorage?.removeItem(REFRESH_KEY);
  } catch {
    // Not fatal: the session still works until the access token expires.
  }
}
