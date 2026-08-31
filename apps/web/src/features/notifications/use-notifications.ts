import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiGet, apiPost } from '../../lib/api-client';

/**
 * Persisted notifications — the ones the worker created.
 *
 * Distinct from the derived "attention" counts already in the shell, and both
 * belong. The derived items answer "what does the current data say needs
 * doing"; these answer "what has the system already told you about". A
 * notification survives being read, is the same on web and on Android, and is
 * the evidence that a reminder actually happened.
 *
 * The DATABASE is the single source of truth. A push notification is a copy
 * that arrives faster, never a separate fact — which is why marking one read on
 * a phone changes what the web shows, and why a push that never arrives costs
 * nothing but timeliness.
 */

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

export function useNotifications(unreadOnly = false): UseQueryResult<{
  items: Notification[];
  unread: number;
}> {
  const queryClient = useQueryClient();

  /*
   * A push arriving while the app is in the FOREGROUND does not raise an OS
   * notification — the tray stays quiet by design, so nothing is shown twice.
   * The native layer emits this event instead, and the bell refreshes from the
   * database rather than trusting the payload. One source of truth, even when
   * a faster copy is sitting right there.
   */
  useEffect(() => {
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };

    window.addEventListener('leadflow:notification-received', refresh);
    return () => window.removeEventListener('leadflow:notification-received', refresh);
  }, [queryClient]);

  return useQuery({
    queryKey: ['notifications', { unreadOnly }],
    queryFn: () =>
      apiGet<{ items: Notification[]; unread: number }>(
        '/notifications',
        unreadOnly ? { unreadOnly: true, limit: 30 } : { limit: 30 },
      ),
    // A reminder that is a minute stale is still a reminder. Polling harder
    // would cost battery on the device this matters most on.
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiPost<{ unread: number }>(`/notifications/${id}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiPost<{ cleared: number; unread: number }>('/notifications/read-all'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

/**
 * Where a notification should take the user.
 *
 * The same mapping the native deep-link handler uses, deliberately shared
 * rather than duplicated: a tap on a phone and a click in the bell must land in
 * the same place, and two copies of this would drift the first time a route
 * changed.
 */
export function notificationRoute(notification: Notification): string {
  if (!notification.entityId) return '/follow-ups';

  switch (notification.entityType) {
    case 'FollowUp':
      return `/follow-ups?focus=${notification.entityId}`;
    case 'Account':
      return `/customers/${notification.entityId}`;
    case 'Lead':
      return `/leads/${notification.entityId}`;
    default:
      return '/follow-ups';
  }
}
