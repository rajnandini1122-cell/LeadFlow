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
 * Deliberately NOT applied to debug builds: pointing a debug APK at a LAN
 * address is exactly what a developer testing on a real handset needs to do.
 */

const url = process.env.VITE_API_BASE_URL;
const failures = [];

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
      failures.push(
        `VITE_API_BASE_URL points at ${parsed.hostname}, which is this machine.\n` +
          '    A release build must point at the production API.',
      );
    }

    // A private range is the same mistake wearing a different address.
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname)) {
      failures.push(
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
      failures.push(
        `VITE_API_BASE_URL uses ${parsed.protocol.replace(':', '')}, not https.\n` +
          '    Tokens would travel in the clear, and Android blocks cleartext by default.',
      );
    }
  }
}

if (failures.length > 0) {
  console.error('\nRelease build refused — configuration is not shippable:\n');
  for (const failure of failures) console.error(`  • ${failure}\n`);
  console.error('See docs/android.md.\n');
  process.exit(1);
}

console.log(`Release configuration OK — API base URL: ${url}`);
