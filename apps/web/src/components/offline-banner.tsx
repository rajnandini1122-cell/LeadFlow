import { useSyncExternalStore } from 'react';
import { onlineManager } from '@tanstack/react-query';

/**
 * Says so when the device is offline.
 *
 * Offline, TanStack Query HOLDS a save and sends it on reconnect rather than
 * failing it. Correct — nothing is lost while the app is open — but on a phone
 * it looked like a save stuck on "Saving…" forever with no reason given (found
 * on the emulator). This tells the rep what is happening and what to do.
 */
export function OfflineBanner(): React.JSX.Element | null {
  const online = useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
  );
  if (online) return null;

  return (
    <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
      You’re offline. Anything you save is sent as soon as you’re back online — keep the app open until then.
    </div>
  );
}
