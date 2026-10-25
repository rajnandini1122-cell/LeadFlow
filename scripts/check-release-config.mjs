/**
 * Refuses to produce an Android release build that cannot work.
 *
 * The P2 audit built a release APK and found it contained no API URL at all:
 * `VITE_API_BASE_URL` was unset, so `apiBaseUrl()` would throw on launch. The
 * app failing loudly on the device is the right RUNTIME behaviour — a wrong
 * guess would be far worse — but it means an unshippable artefact gets built,
 * signed, uploaded and installed before anybody discovers it.
 *
 * This moves that discovery to the build. You cannot produce a release APK that
 * points nowhere, or at your laptop.
 *
 * With `--debug` (every `android:sync`), only the two checks that make ANY
 * build useless are enforced: the URL must be set and must parse. The APK
 * committed on 2026-08-22 was a debug build with no URL at all — it installed,
 * opened, and could not reach anything. A LAN address or plain HTTP stays
 * allowed for a debug build, because testing on a real handset needs exactly
 * that; those are printed as warnings instead.
 */

const url = process.env.VITE_API_BASE_URL;
const debug = process.argv.includes('--debug');
const failures = [];
const warnings = [];
// In a debug build, "wrong for production" is a warning, not a stop.
const productionOnly = (message) => (debug ? warnings : failures).push(message);

if (!url) {
  failures.push(
    'VITE_API_BASE_URL is not set.\n' +
      '    A release APK has no relative origin to fall back on — the WebView is\n' +
      '    served from https://localhost, so a relative path resolves to the APK\n' +
      '    itself. Set it to the production API origin.',
  );
} else {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    failures.push(`VITE_API_BASE_URL is not a valid URL: ${url}`);
  }

  if (parsed) {
    // A laptop address in a release build is the single most likely mistake,
    // and it produces an app that works for exactly one person on one network.
    const localHosts = ['localhost', '127.0.0.1', '0.0.0.0', '10.0.2.2', '[::1]'];

    if (localHosts.includes(parsed.hostname)) {
      productionOnly(
        `VITE_API_BASE_URL points at ${parsed.hostname}, which is this machine.\n` +
          '    A release build must point at the production API.',
      );
    }

    // A private range is the same mistake wearing a different address.
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname)) {
      productionOnly(
        `VITE_API_BASE_URL points at the private address ${parsed.hostname}.\n` +
          '    That works on one network and nowhere else.',
      );
    }

    /*
     * Plaintext HTTP would carry the access token in the clear, and Android 9+
     * blocks it anyway unless cleartext is explicitly allowed — which this app
     * does not do. Failing here beats an APK that cannot reach its own API.
     */
    if (parsed.protocol !== 'https:') {
      productionOnly(
        `VITE_API_BASE_URL uses ${parsed.protocol.replace(':', '')}, not https.\n` +
          '    Tokens would travel in the clear, and Android blocks cleartext by default.',
      );
    }
  }
}

for (const warning of warnings) console.warn(`  ! ${warning}\n`);

if (failures.length > 0) {
  console.error(`\n${debug ? 'Android build' : 'Release build'} refused — configuration is not shippable:\n`);
  for (const failure of failures) console.error(`  • ${failure}\n`);
  console.error('See docs/android.md.\n');
  process.exit(1);
}

console.log(`${debug ? 'Debug' : 'Release'} configuration OK — API base URL: ${url}`);
