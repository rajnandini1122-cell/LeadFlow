import type { PushNotifications } from '@capacitor/push-notifications';
import { apiPost } from './api-client';
import { isNativeApp } from './platform';

/**
 * Push notifications on Android.
 *
 * Everything here is a no-op in a browser. The plugin is imported lazily so a
 * web bundle never loads native code it cannot use, and so the browser build
 * stays the size it was.
 *
 * The division of responsibility is deliberate and one-directional:
 *
 *   The SERVER decides what is worth notifying about, who receives it, and
 *   persists the notification. That row is the source of truth.
 *
 *   The DEVICE is a presentation endpoint. It registers a token, displays what
 *   arrives, and routes a tap. It never decides anything, and it never treats a
 *   push as data — the payload carries ids, and the screen fetches the real
 *   record over an authenticated connection.
 *
 * Which means a push that never arrives costs nothing but timeliness: the
 * notification is still in the bell.
 */

/** Where a notification should take the user. Resolved from ids, never a URL. */
export function routeForNotification(payload: {
  type?: string;
  entityType?: string;
  entityId?: string;
}): string {
  const { entityType, entityId } = payload;

  if (!entityId) return '/notifications';

  /*
   * Routed by ENTITY, not by notification type.
   *
   * Several types point at the same place — a due reminder, an overdue alert
   * and a manager escalation are all about one follow-up — so switching on
   * type would mean three branches that must be kept agreeing with each other.
   * The entity is the stable fact.
   */
  switch (entityType) {
    case 'FollowUp':
      // Follow-ups live on the lead they belong to; the follow-up id is the
      // anchor so the right one can be highlighted.
      return `/follow-ups?focus=${entityId}`;
    case 'Account':
      return `/customers/${entityId}`;
    case 'Lead':
      return `/leads/${entityId}`;
    default:
      return '/notifications';
  }
}

/*
 * The plugin type comes from a static type-only import, while the VALUE is
 * still loaded dynamically below. A type import is erased at build time, so the
 * browser bundle carries no native code — which is the property that mattered.
 */
type PushPlugin = typeof PushNotifications;

async function plugin(): Promise<PushPlugin | null> {
  if (!isNativeApp()) return null;

  try {
    const module = await import('@capacitor/push-notifications');
    return module.PushNotifications;
  } catch {
    // The plugin is absent in a browser build. Not an error — push simply is
    // not available, and every caller already handles that.
    return null;
  }
}

/**
 * Asks for permission, registers, and reports the token to LeadFlow.
 *
 * Called after sign-in, because a token is meaningless without knowing whose it
 * is — and because asking for notification permission before someone has even
 * logged in is the prompt everybody declines.
 *
 * Safe to call repeatedly. The server upserts on the token, so re-registering
 * on every launch updates one row rather than accumulating dead ones.
 */
export async function registerForPush(
  onOpened: (route: string) => void,
): Promise<{ registered: boolean; reason?: string }> {
  const push = await plugin();
  if (!push) return { registered: false, reason: 'not a native app' };

  try {
    let permission = await push.checkPermissions();

    if (permission.receive === 'prompt' || permission.receive === 'prompt-with-rationale') {
      permission = await push.requestPermissions();
    }

    if (permission.receive !== 'granted') {
      // A declined prompt is a choice, not a failure. In-app notifications
      // keep working and nothing is retried behind the user's back.
      return { registered: false, reason: 'permission not granted' };
    }

    // Listeners are attached BEFORE registering, or the token that arrives
    // milliseconds later has nowhere to go.
    await push.removeAllListeners();

    await push.addListener('registration', (token) => {
      // Held so sign-out can unregister THIS device specifically. Without it
      // unregisterFromPush had nothing to send and silently did nothing.
      rememberToken(token.value);

      void apiPost('/users/me/devices', {
        token: token.value,
        platform: 'ANDROID',
        label: deviceLabel(),
      }).catch(() => {
        /*
         * Swallowed deliberately. A failed registration must not break sign-in
         * or surface an error the user can do nothing about — the next launch
         * re-registers, and until then the bell still works.
         */
      });
    });

    await push.addListener('registrationError', () => {
      // Nothing to tell the user. Push is unavailable; the app is not.
    });

    /*
     * Foreground: the OS does not raise a tray notification while the app is
     * open, so nothing is shown twice. The bell is refreshed instead, which is
     * the in-app equivalent and keeps one source of truth.
     */
    await push.addListener('pushNotificationReceived', () => {
      window.dispatchEvent(new CustomEvent('leadflow:notification-received'));
    });

    // Background or cold start: the user tapped, so take them there.
    await push.addListener('pushNotificationActionPerformed', (action) => {
      const data = action.notification.data as {
        type?: string;
        entityType?: string;
        entityId?: string;
      };

      onOpened(routeForNotification(data));
    });

    await push.register();

    return { registered: true };
  } catch (error) {
    return {
      registered: false,
      reason: error instanceof Error ? error.message : 'registration failed',
    };
  }
}

/**
 * Tells the server to stop pushing to THIS device.
 *
 * By token, so signing out on a phone does not silence the same person's
 * tablet. Best-effort: a sign-out must complete even if the call fails, because
 * the alternative is a user who cannot log out.
 */
export async function unregisterFromPush(): Promise<void> {
  const push = await plugin();
  if (!push) return;

  try {
    const token = lastToken;
    if (token) {
      await apiPost('/users/me/devices/unregister', { token }).catch(() => {});
    }

    await push.removeAllListeners();
  } catch {
    // Sign-out proceeds regardless.
  }
}

/**
 * The last token this device was issued.
 *
 * Held in memory only. It is a credential, and `localStorage` is already
 * carrying the refresh token under protest — adding a second one there would
 * widen a gap the audit already recorded rather than narrowing it.
 */
let lastToken: string | null = null;

export function rememberToken(token: string): void {
  lastToken = token;
}

/** A human label for the device list. No identifiers, no fingerprinting. */
function deviceLabel(): string {
  const platform = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return platform?.getPlatform?.() === 'android' ? 'Android device' : 'Device';
}
