import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android packaging for the existing LeadFlow web app.
 *
 * `webDir` points at the SAME `dist/` that `npm run build -w apps/web`
 * produces. There is no second application, no duplicated screens and no
 * separate API client — the APK ships the bundle the browser already runs, so
 * anything fixed on the web is fixed in the app on the next build.
 *
 * Nothing here is a secret. The application id and name are public by
 * definition, and the API address is supplied at build time through
 * VITE_API_BASE_URL rather than being written into source, because it differs
 * per machine and per environment. No token, key or credential is ever
 * compiled into the APK.
 */
const config: CapacitorConfig = {
  appId: 'app.leadflow.crm',
  appName: 'LeadFlow',
  webDir: 'dist',

  android: {
    /*
     * The app page is https://localhost, so the WebView blocks every request
     * to an http:// API as mixed content — a debug APK pointed at a dev API
     * could not even sign in ("Network Error"; found on the emulator).
     *
     * So it is allowed ONLY when the API this build targets is itself http://.
     * That can only be a debug build: `android:release` refuses a non-https
     * VITE_API_BASE_URL, so every release APK has this false. Evaluated at
     * `cap sync`, from the same variable the bundle was built with.
     */
    allowMixedContent: (process.env['VITE_API_BASE_URL'] ?? '').startsWith('http://'),
  },

  server: {
    /*
     * Serve over https://localhost inside the WebView.
     *
     * The default `http://localhost` makes the WebView an insecure origin,
     * which disables `crypto.randomUUID()` — the function the message composer
     * uses to build idempotency keys. Without it, sending would break in the
     * app and only in the app.
     */
    androidScheme: 'https',
  },
};

export default config;
