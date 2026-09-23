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
     * A plain HTTP API is refused by Android 9+ unless cleartext is allowed.
     *
     * Left FALSE here, which is the safe default and what a real deployment
     * wants. Local development against http://<lan-ip>:3000 needs it enabled —
     * that is a documented, deliberate step in docs/android.md rather than
     * something switched on quietly for everyone.
     */
    allowMixedContent: false,
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
