/**
 * Build-time configuration this app reads.
 *
 * Declared narrowly rather than pulling in `vite/client` wholesale: the only
 * thing the code needs is one optional string, and a precise declaration means
 * a typo in a variable name is a compile error instead of `undefined` at
 * runtime in the Android app.
 *
 * VITE_ variables are compiled into the bundle and are readable by anyone who
 * has it. Only public values belong here — an API address is public, a
 * credential never is.
 */
interface ImportMetaEnv {
  /**
   * Absolute origin of the LeadFlow API, e.g. `https://api.example.com`.
   *
   * Unset for an ordinary browser build, which uses a relative `/api/v1` and
   * therefore keeps the refresh cookie same-origin. REQUIRED for the Android
   * build, where a relative URL would point at the APK's own assets.
   */
  readonly VITE_API_BASE_URL?: string;

  /**
   * 'true' when the Android build had Firebase configured
   * (android/app/google-services.json). Set by vite.config.ts; push is never
   * touched otherwise, because registering without Firebase crashes the app.
   */
  readonly VITE_ANDROID_PUSH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
