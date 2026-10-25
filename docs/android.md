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

The token is stored in Android's `EncryptedSharedPreferences` (Keystore-backed, via
`@aparajita/capacitor-secure-storage`), not in WebView `localStorage`. Every caller
goes through `storeRefreshToken` / `hydrateRefreshToken` in
[`platform.ts`](../apps/web/src/lib/platform.ts).

### What the app adds to the browser behaviour

These were all found on Android, not in the browser:

| | Browser | Android app |
|---|---|---|
| Hardware **Back** | — | Closes an open dialog, then goes back a page. It leaves the app only from the first screen. Without this, Back closed the app from any screen. |
| Returning to the app after a call | Tab focus refetches stale data | The native app-state event drives the same refetch, so counts are current when the rep comes back from the dialer |
| CSV export, attachment download | Browser download | The file is written to the app cache and opened in Android's **share sheet** (WhatsApp, Drive, Files). A `blob:` download does nothing in a WebView. |
| Opening `/` signed out | Marketing page | Straight to **Sign in** |
| Call button | `tel:` link | The same `tel:` link opens the dialer through an Android intent. No `CALL_PHONE` permission. Nothing is logged until the rep saves an outcome. |
| Reopening after Android killed the app | The cookie restores the session | The startup restore sends the **stored** refresh token. It used to send nothing, so every relaunch signed the rep out. |
| Push notifications | — | Registered only when the APK was built **with** `android/app/google-services.json`. Without Firebase, `register()` crashes the app (`FATAL EXCEPTION: CapacitorPlugins … Default FirebaseApp is not initialized`, reproduced on the emulator), so it is not called. Registration also never ran before: returning the plugin proxy from an async function triggered `"PushNotifications.then()" is not implemented`. |

### Push needs Firebase

The repository has no `google-services.json`, so **APKs built from it have no push
notifications**. In-app notifications (the bell) still work. To enable push, add the
Firebase project's `google-services.json` at `apps/web/android/app/` before building.
The build detects the file and turns push on. Never commit that file.

Everything else — screens, hooks, permissions, tenant isolation, conversation
visibility — is the same code running the same way.

### Permissions the APK requests

`INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `WAKE_LOCK` and
`com.google.android.c2dm.permission.RECEIVE` (push). No phone, contacts, location or
storage permissions.

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

### Build guards

These exist because the APK published on 2026-08-22 was a debug build with **no API
address compiled in**. It installed and opened, then failed every request.

- **`android:sync`** (and so `android:build`) refuses to run unless `VITE_API_BASE_URL`
  is set to a valid URL. A LAN address or `http` is allowed for a debug build, with a
  warning. `android:release` additionally requires `https` and a public host.
- **`build-info.json`** is written into the app's assets after `cap sync`, recording the
  API origin, the source commit and branch, and whether the tree had uncommitted
  changes. It travels inside the APK. Check it with
  `apkanalyzer files cat --file /assets/public/build-info.json app-debug.apk`.
- **`android:publish`** copies nothing unless:
  - the build info names an API;
  - that API is not this machine (override with `--allow-local`);
  - the assets predate the APK;
  - `versionCode` is higher than the published one, since Android refuses an
    "update" that isn't.
  The manifest it writes includes the API origin and the source commit.

### Versioning

`versionCode` / `versionName` live in `android/app/build.gradle`. Raise `versionCode`
for **every** APK given to users. 1 / "1.0" was the 2026-08-22 build; 2 / "1.1.0" is
the first build with the sales workspace.

### Releasing alongside the API

The APK ships the web bundle of the commit it was built from and calls that commit's
API. **Publish a new APK only after the matching API is deployed.** Otherwise it calls
endpoints production does not have yet, such as `/workspace/summary`,
`/leads/:id/outcomes` and `/leads/:id/attachments`.

### Production prerequisite: CORS

The app's pages are served from `https://localhost` inside the phone, so every API
call is cross-origin. Production's API must list that origin. As of 2026-10-25 it
does not: a preflight from `https://localhost` to
`https://leadflow.cravionventures.com` returns no `Access-Control-Allow-Origin`, and
the app could not sign in. In Railway, add it to the API service's `CORS_ORIGINS`
(comma-separated), keeping the existing values:

```
CORS_ORIGINS=<existing origins>,https://localhost
```

Check it, read-only, with:

```bash
curl -s -D - -o /dev/null -X OPTIONS \
  -H "Origin: https://localhost" -H "Access-Control-Request-Method: POST" \
  https://leadflow.cravionventures.com/api/v1/auth/login | grep -i access-control-allow-origin
# expected: access-control-allow-origin: https://localhost
```

### Release signing

Nothing secret is in this repository, and keystores are git-ignored.
`app/build.gradle` reads four values from environment variables, or from the
builder's own `~/.gradle/gradle.properties`, never the project's:

| Variable | Value |
|---|---|
| `LEADFLOW_UPLOAD_STORE_FILE` | path to the release keystore (`.jks`) |
| `LEADFLOW_UPLOAD_STORE_PASSWORD` | keystore password |
| `LEADFLOW_UPLOAD_KEY_ALIAS` | key alias |
| `LEADFLOW_UPLOAD_KEY_PASSWORD` | key password |

Without them, `assembleRelease` produces **`app-release-unsigned.apk`**, which cannot
be installed. That's the safe default.

To create the key, once, and keep it outside the repository, backed up in two places.
Losing it means existing installs can never be updated:

```bash
keytool -genkeypair -v -keystore leadflow-release.jks -alias leadflow \
  -keyalg RSA -keysize 2048 -validity 10000
```

Build:

```bash
set VITE_API_BASE_URL=https://leadflow.cravionventures.com
set LEADFLOW_UPLOAD_STORE_FILE=D:\secure\leadflow-release.jks
# …the three passwords/alias, typed into the shell, never into a file in the repo
npm run android:release -w apps/web
```

The output is `android/app/build/outputs/apk/release/app-release.apk`. The release
APK:
- is not debuggable;
- has WebView debugging off;
- has no cleartext exception and has `allowBackup="false"`.

Its `build-info.json` names the HTTPS API and the source commit.

**Signing changes the app's identity.** Every APK given out so far was debug-signed,
so phones must **uninstall the old app** before installing the first release-signed
one. After that, release builds update in place.

### Keyboard on Android 15

`targetSdk 35` enforces edge-to-edge, and in that mode the window no longer resizes
for the keyboard, so a field near the bottom was typed blind behind it. The app
themes opt out with `android:windowOptOutEdgeToEdgeEnforcement`, and the activity
uses `adjustResize`. Moving to full inset handling later means removing the opt-out
together.

### Cleartext HTTP for local development

Two separate blocks stop an `http://` API, and both apply to debug builds only:

1. **Mixed content.** The app page is `https://localhost`, so the WebView blocks
   `http://` requests outright, and sign-in shows "Network Error".
   `capacitor.config.ts` sets `allowMixedContent` to true only when
   `VITE_API_BASE_URL` itself starts with `http://`. A release build is always
   `https`, because `android:release` refuses anything else.
2. **Cleartext.** Android 9+ refuses plain `http://`. Debug builds allow cleartext
   only to `10.0.2.2`, the emulator's alias for the host, through
   `app/src/debug/res/xml/network_security_config_debug.xml`. A release build has no
   exception. A physical phone on a LAN address needs that domain added locally; don't
commit it.

On the emulator the API must also allow the WebView's origin:
`CORS_ORIGINS=…,https://localhost`.

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
