# LeadFlow for Android

The Android app is the **existing web application** packaged with Capacitor. There is
no second codebase: no duplicated screens, no separate API client, no parallel
business logic. `webDir` points at the same `apps/web/dist` the browser gets, so a fix
on the web is a fix in the app on the next build.

---

## 1. What actually differs from the browser

Exactly two things, and both are forced by the WebView rather than chosen.

### The API address

A browser is served from the same origin as the API (or proxied to it by Vite), so a
relative `/api/v1` works. A Capacitor WebView is served from `https://localhost` — its
own bundled assets — so a relative URL would resolve to the APK itself.

The app therefore needs an **absolute** API URL, supplied at build time:

```bash
VITE_API_BASE_URL=https://api.example.com
```

It is read in [`apps/web/src/lib/platform.ts`](../apps/web/src/lib/platform.ts). It is
**not** in source, because it differs per machine and per environment. It is also not a
secret — an API address is discoverable by anyone holding the app — and **no
credential of any kind is compiled into the APK**.

Build without it and the app fails loudly with one clear message instead of a confusing
network error on every screen. That is deliberate: there is no sensible default, since
`localhost` inside the WebView is the APK.

| Where you are running | `VITE_API_BASE_URL` |
|---|---|
| Browser, `npm run dev:web` | unset — the Vite proxy handles it |
| Browser, production | unset if the API is same-origin |
| Android emulator | `http://10.0.2.2:3000` (the emulator's alias for your host) |
| Physical device, same Wi-Fi | `http://<your-lan-ip>:3000` |
| Production | `https://api.yourdomain.com` |

### Where the refresh token lives

The web keeps it in an `httpOnly`, `SameSite=Strict` cookie. That is the strongest
option available and **it is unchanged**.

That cookie cannot cross from `https://localhost` to an API on another origin, and
relaxing it to `SameSite=None` would weaken CSRF protection for every browser user in
order to serve the app. So the app uses the token-in-body path the API has supported
since Phase 1 — it sends `platform: 'ANDROID'` and stores the token itself.

This is an honest trade, not a claim of equivalence: WebView `localStorage` is weaker
than Android's `EncryptedSharedPreferences`. What makes it acceptable is that the
WebView loads a fixed bundle from the APK with no remote script origin and no
user-supplied HTML, so the XSS surface a browser tab has is largely absent. Moving to
encrypted native storage is a plugin swap behind `storeRefreshToken`, which is why
every caller goes through that function.

Everything else — screens, hooks, permissions, tenant isolation, conversation
visibility — is the same code running the same way.

---

## 2. Prerequisites

| | |
|---|---|
| JDK | 21 (`java -version`) |
| Android SDK | with a platform matching `compileSdkVersion` in `apps/web/android/variables.gradle` |
| Gradle | not needed — the wrapper downloads it on first build (~130 MB) |
| Android Studio | optional; only for `android:open` and the emulator |

`apps/web/android/local.properties` must point at your SDK. It is **git-ignored** and
regenerated per machine:

```properties
sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
```

Note the escaping — this is a Java properties file, so backslashes are doubled and the
drive colon is escaped. A malformed path fails with
`java.io.IOException: The filename, directory name, or volume label syntax is incorrect`,
which does not mention the path at all.

---

## 3. Building

```bash
# From the repository root.

# 1. Build the web bundle and copy it into the Android project.
npm run android:sync

# 2. Build a debug APK.
npm run android:build

# 3. Publish it to the web app's download page.
npm run android:publish
```

To build against a specific API:

```bash
cd apps/web
VITE_API_BASE_URL=http://192.168.1.20:3000 npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK lands at:

```
apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

Open the project in Android Studio instead with `npm run android:open`.

### Cleartext HTTP for local development

Android 9+ refuses plain `http://`. `allowMixedContent` is **false** in
`capacitor.config.ts`, which is what a real deployment wants. To test against a local
API over HTTP, add a network security config to the Android project — a deliberate,
temporary local step, not something switched on for everyone.

---

## 4. Distribution

There is **no Play Store listing**, and this does not add one.

`npm run android:publish` copies the APK into `apps/web/public/downloads/` and writes
`leadflow-apk.json` beside it containing the real file size, SHA-256, `versionName`,
`versionCode` and build time — all **read from the Gradle output**, none typed in.

The home page reads that manifest and renders a download card. If the manifest is
missing, it renders **nothing** — a deployment without a published APK shows no button
rather than a link that 404s.

Vite copies `public/` into `dist/` verbatim, so the APK is served by whatever already
hosts the web app. No new infrastructure.

### Installing

1. Open LeadFlow in the phone's browser and tap **Download APK**.
2. Android will warn about installing from an unknown source — allow it for the
   browser. This is expected for any app not from the Play Store.
3. Open the downloaded file and install.

The published build is a **debug** APK. It is signed with the shared Android debug key,
which means it installs and runs but cannot be upgraded in place by a release build
later. The download card states the build type for exactly this reason. Producing a
release APK needs a signing keystore, which is a deployment decision and is out of
scope here.

---

## 5. What to check on the device

Works against seeded demo data, with no Meta configuration:

- Log in as a demo user (see [`local-development.md`](./local-development.md))
- Dashboard figures, navigation drawer, Leads list and lead detail
- Creating and editing a lead, follow-ups
- Inbox, conversation list, opening a conversation, reading the timeline
- Message delivery states, including the failed and unconfirmed examples
- The WhatsApp template picker on a conversation whose window has closed
- Review queue, and the three link states
- Signing in as different roles and seeing genuinely different data

Requires real Meta credentials — seeded conversations are **not** connected to
WhatsApp, Instagram or Facebook, and no seeded channel is marked connected:

- Actually sending a message or a template
- Receiving a real inbound message
- Downloading a real media attachment
- Syncing templates from Meta

---

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| Every request fails in the app, works in the browser | `VITE_API_BASE_URL` unset, wrong, or pointing at `localhost` |
| `IOException: The filename, directory name, or volume label syntax is incorrect` | `local.properties` escaping — see §2 |
| `Failed to find target with hash string 'android-NN'` | That SDK platform is not installed |
| Sending fails only in the app | `androidScheme` is not `https`, so `crypto.randomUUID()` is unavailable on an insecure origin |
| Logged out on every launch | Refresh token not stored — check the app is sending `platform: 'ANDROID'` |
