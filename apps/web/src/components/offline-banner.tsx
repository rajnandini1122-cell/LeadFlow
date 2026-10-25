import { useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';

/** Whether the device is online, as TanStack Query sees it (it holds saves while offline). */
export function useIsOnline(): boolean {
  return useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
  );
}

/** The label for a busy save button: honest about a save held for the connection. */
export function useBusyLabel(busyLabel: string): string {
  return useIsOnline() ? busyLabel : 'Waiting for connection…';
}

/**
 * Says so when the device is offline.
 *
 * Offline, TanStack Query HOLDS a save and sends it on reconnect rather than
 * failing it. Correct — nothing is lost while the app is open — but on a phone
 * it looked like a save stuck on "Saving…" forever with no reason given (found
 * on the emulator). This tells the rep what is happening and what to do.
 */
export function OfflineBanner(): React.JSX.Element | null {
  if (useIsOnline()) return null;

  return (
    <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
      You’re offline. Anything you save is sent as soon as you’re back online — keep the app open until then.
    </div>
  );
}
