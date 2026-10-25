import { focusManager } from '@tanstack/react-query';
import type { App as AppPlugin } from '@capacitor/app';
import { isNativeApp } from './platform';

/**
 * What the Android app needs from its shell that a browser tab gets for free.
 *
 * Two things, both found on a device rather than in theory:
 *
 * BACK. Without a handler, Android's back gesture finishes the activity — the
 * app closed from a lead page instead of going back to the list. Back now
 * closes an open dialog first, then steps back through history, and only
 * leaves the app from the first screen.
 *
 * RESUME. A rep taps Call, talks in the dialer, and comes back. The app must
 * show current numbers then, not the ones from before the call. The WebView's
 * own visibility events are not reliable across Android versions, so the
 * native app-state event drives TanStack Query's focus manager directly — the
 * same mechanism that refetches stale queries when a browser tab regains focus.
 *
 * A no-op in the browser.
 */
export async function installNativeShell(): Promise<void> {
  if (!isNativeApp()) return;

  let App: typeof AppPlugin;
  try {
    ({ App } = await import('@capacitor/app'));
  } catch {
    return;
  }

  await App.addListener('backButton', ({ canGoBack }) => {
    handleBack(canGoBack, () => void App.exitApp());
  });

  await App.addListener('appStateChange', ({ isActive }) => {
    focusManager.setFocused(isActive);
  });
}

/** Exported for tests: the decision Back makes, without the plugin. */
export function handleBack(canGoBack: boolean, exit: () => void): void {
  // Every dialog in this app closes on Escape; Back means the same thing.
  if (document.querySelector('[role="dialog"], [aria-modal="true"]')) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return;
  }
  if (canGoBack && window.history.length > 1) {
    window.history.back();
    return;
  }
  exit();
}
