import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCompleteFollowUp } from '../features/leads/use-lead-mutations';
import * as apiClient from '../lib/api-client';

/**
 * What has to refresh when a follow-up is completed.
 *
 * The overdue count is shown in three places from two endpoints: the sidebar
 * badge and the attention bell read `/follow-ups`, the dashboard tile reads
 * `/dashboard`. Miss one and the screen contradicts itself — "6 overdue" in a
 * tile beside a badge already showing 5.
 *
 * A count that does not move when you do the work is worse than no count,
 * because it stops being believed.
 */

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

let client: QueryClient;

beforeEach(() => {
  vi.restoreAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('completing a follow-up', () => {
  it('refreshes every count that shows it', async () => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCompleteFollowUp(), { wrapper: wrapper(client) });

    result.current.mutate({ id: 'fu-1', outcome: 'Spoke to them', leadId: 'lead-1' } as never);

    await waitFor(() => expect(invalidate).toHaveBeenCalled());

    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));

    // The two endpoints that both report overdue work.
    expect(keys).toContain(JSON.stringify(['follow-ups']));
    expect(keys).toContain(JSON.stringify(['dashboard']));
    // And the lead itself, whose next action just changed.
    expect(keys).toContain(JSON.stringify(['leads']));
  });

  it('refreshes the lead it belongs to', async () => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useCompleteFollowUp(), { wrapper: wrapper(client) });

    result.current.mutate({ id: 'fu-1', outcome: 'Done', leadId: 'lead-42' } as never);

    await waitFor(() => expect(invalidate).toHaveBeenCalled());

    const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));

    // The timeline gains an entry and the next action changes, so the detail
    // page must not keep showing the follow-up that was just closed.
    expect(keys).toContain(JSON.stringify(['lead', 'lead-42']));
    expect(keys).toContain(JSON.stringify(['lead-activities', 'lead-42']));
    expect(keys).toContain(JSON.stringify(['lead-follow-ups', 'lead-42']));
  });
});
