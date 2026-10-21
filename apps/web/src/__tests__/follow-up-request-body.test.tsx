import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../lib/api-client';
import { useCompleteFollowUp, useRescheduleFollowUp } from '../features/leads/use-lead-mutations';

/**
 * Complete and Reschedule never reached the server.
 *
 * Both hooks spread everything except `id` into the request body, including
 * `leadId`, which the dialogs always pass so the right caches refresh. The API
 * runs with `forbidNonWhitelisted`, so every such request was refused with a
 * validation error before the follow-up was touched. The existing hook tests
 * mocked apiPost and never looked at the body, which is how it went unnoticed.
 */

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

const client = (): QueryClient =>
  new QueryClient({ defaultOptions: { mutations: { retry: false } } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('follow-up request bodies', () => {
  it('completes without leadId in the body', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    const { result } = renderHook(() => useCompleteFollowUp(), { wrapper: wrapper(client()) });

    result.current.mutate({
      id: 'fu-1',
      leadId: 'lead-1',
      outcome: 'Interested',
      nextFollowUpAt: '2026-11-01T05:30:00.000Z',
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith('/follow-ups/fu-1/complete', {
      outcome: 'Interested',
      nextFollowUpAt: '2026-11-01T05:30:00.000Z',
    });
  });

  it('reschedules without leadId in the body', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    const { result } = renderHook(() => useRescheduleFollowUp(), { wrapper: wrapper(client()) });

    result.current.mutate({ id: 'fu-2', leadId: 'lead-2', scheduledAt: '2026-11-02T05:30:00.000Z' });

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith('/follow-ups/fu-2/reschedule', {
      scheduledAt: '2026-11-02T05:30:00.000Z',
    });
  });

  it('still refreshes the lead it was told about', async () => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    const queryClient = client();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useCompleteFollowUp(), { wrapper: wrapper(queryClient) });

    result.current.mutate({ id: 'fu-3', leadId: 'lead-3', outcome: 'Done', nextFollowUpAt: '2026-11-03T05:30:00.000Z' });

    await waitFor(() =>
      expect(invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey))).toContain(
        JSON.stringify(['lead', 'lead-3']),
      ),
    );
  });
});
