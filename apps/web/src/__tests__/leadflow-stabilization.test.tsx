import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';
import { setFormattingContext } from '../lib/format';
import { toZonedInput, zonedDefault, zonedInputToIso } from '../lib/zoned-input';
import { newIdempotencyKey } from '../lib/idempotency';
import {
  useCompleteFollowUp,
  useRecordAttempt,
  useRescheduleFollowUp,
} from '../features/leads/use-lead-mutations';
import { FollowUpsPage } from '../features/followups/follow-ups-page';

/**
 * LeadFlow stabilization, client side.
 *
 *   1. COMPLETE AND RESCHEDULE NEVER REACHED THE SERVER. The hooks spread
 *      everything but `id` into the request body — including `leadId`, which
 *      they hold only to refresh caches. The API refuses unknown fields, so
 *      every Complete and Reschedule pressed in a dialog was rejected.
 *
 *   2. TYPED TIMES USED THE DEVICE'S TIMEZONE. Displayed times use the
 *      organization's; typed times were read in the browser's. On a device not
 *      set to IST, "11:00" saved as some other hour.
 *
 *   3. A DOUBLE CLICK WAS TWO ACTIONS. Each request now carries one
 *      Idempotency-Key per dialog opening.
 *
 *   4. "NO ANSWER" WAS NOT IN THE QUEUE. Agents had to leave the queue to log it.
 */

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

const newClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

beforeEach(() => {
  setFormattingContext({ locale: 'en-IN', currency: 'INR', timezone: 'Asia/Kolkata' });
});

afterEach(() => {
  vi.restoreAllMocks();
  setFormattingContext({ locale: 'en-US', currency: 'USD', timezone: 'UTC' });
});

// =============================================================================
// 2. Organization timezone, both directions
// =============================================================================

describe('datetime-local values in the organization timezone', () => {
  it('reads a typed time as IST, whatever zone the device is in', () => {
    // 11:00 in Kolkata is 05:30 UTC. Never 11:00 UTC, which is what a device
    // left on UTC used to save.
    expect(zonedInputToIso('2026-10-21T11:00', 'Asia/Kolkata')).toBe('2026-10-21T05:30:00.000Z');
  });

  it('defaults to the organization timezone from the session', () => {
    expect(zonedInputToIso('2026-10-21T11:00')).toBe('2026-10-21T05:30:00.000Z');
  });

  it('shows an instant as IST wall-clock time', () => {
    expect(toZonedInput(new Date('2026-10-21T05:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-10-21T11:00');
  });

  it('round-trips without drifting', () => {
    const typed = '2026-12-31T23:45';
    expect(toZonedInput(new Date(zonedInputToIso(typed)))).toBe(typed);
  });

  it('crosses midnight correctly', () => {
    // 02:00 IST on the 22nd is still the 21st in UTC.
    expect(zonedInputToIso('2026-10-22T02:00', 'Asia/Kolkata')).toBe('2026-10-21T20:30:00.000Z');
  });

  it('handles a daylight-saving zone on the changeover day', () => {
    // New York moves to EDT (UTC-4) at 02:00 on 8 March 2026.
    expect(zonedInputToIso('2026-03-08T12:00', 'America/New_York')).toBe('2026-03-08T16:00:00.000Z');
    expect(zonedInputToIso('2026-03-07T12:00', 'America/New_York')).toBe('2026-03-07T17:00:00.000Z');
  });

  it('puts the default on the organization calendar at the hour asked for', () => {
    const value = zonedDefault(1, 11);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T11:00$/);
    // Tomorrow, in IST: a day after today's IST date.
    const todayIst = toZonedInput(new Date()).slice(0, 10);
    const expected = new Date(`${todayIst}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    expect(value.slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it('refuses something that is not a datetime-local value', () => {
    expect(() => zonedInputToIso('tomorrow')).toThrow(RangeError);
  });
});

describe('idempotency keys', () => {
  it('meets the API key format and is unique per call', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// 1 + 3. What the hooks actually send
// =============================================================================

describe('request bodies and headers', () => {
  it('completes WITHOUT leadId in the body, and with the key as a header', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    const { result } = renderHook(() => useCompleteFollowUp(), { wrapper: wrapper(newClient()) });

    result.current.mutate({
      id: 'fu-1',
      leadId: 'lead-1',
      idempotencyKey: 'key-complete-1',
      outcome: 'Interested',
      nextFollowUpAt: '2026-11-01T05:30:00.000Z',
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [url, body, options] = apiPost.mock.calls[0] ?? [];
    expect(url).toBe('/follow-ups/fu-1/complete');
    // THE DEFECT: the API refuses this field, so its presence failed every save.
    expect(body).not.toHaveProperty('leadId');
    expect(body).not.toHaveProperty('idempotencyKey');
    expect(body).toEqual({ outcome: 'Interested', nextFollowUpAt: '2026-11-01T05:30:00.000Z' });
    expect(options).toEqual({ headers: { 'Idempotency-Key': 'key-complete-1' } });
  });

  it('reschedules WITHOUT leadId in the body, and with the key as a header', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    const { result } = renderHook(() => useRescheduleFollowUp(), { wrapper: wrapper(newClient()) });

    result.current.mutate({
      id: 'fu-2',
      leadId: 'lead-2',
      idempotencyKey: 'key-resched-1',
      scheduledAt: '2026-11-02T05:30:00.000Z',
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [url, body, options] = apiPost.mock.calls[0] ?? [];
    expect(url).toBe('/follow-ups/fu-2/reschedule');
    expect(body).toEqual({ scheduledAt: '2026-11-02T05:30:00.000Z' });
    expect(options).toEqual({ headers: { 'Idempotency-Key': 'key-resched-1' } });
  });

  it('sends the attempt key as a header, not in the body', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({} as never);
    const { result } = renderHook(() => useRecordAttempt('lead-3'), { wrapper: wrapper(newClient()) });

    result.current.mutate({
      activityType: 'CALL_NOT_ANSWERED',
      retryAt: '2026-11-03T05:30:00.000Z',
      idempotencyKey: 'key-attempt-1',
    });

    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const [, body, options] = apiPost.mock.calls[0] ?? [];
    expect(body).toEqual({ activityType: 'CALL_NOT_ANSWERED', retryAt: '2026-11-03T05:30:00.000Z' });
    expect(options).toEqual({ headers: { 'Idempotency-Key': 'key-attempt-1' } });
  });
});

// =============================================================================
// 4. "No answer" from the queue
// =============================================================================

const QUEUE_ROW = {
  id: 'fu-9',
  leadId: '01a00000-0000-7000-8000-000000000009',
  leadNumber: 'LD-00009',
  leadName: 'Ravi Kulkarni',
  accountId: null,
  accountName: null,
  companyName: 'Kulkarni Exports',
  mobile: '+919820011009',
  leadStatus: 'NEW',
  leadPriority: 'MEDIUM',
  estimatedValue: null,
  scheduledAt: '2026-10-20T05:30:00.000Z',
  type: 'CALL',
  status: 'OVERDUE',
  title: null,
  notes: null,
  outcome: null,
  completedAt: null,
  assignedTo: { id: 'user-1', fullName: 'Asha Rep' },
  isOverdue: true,
};

function renderQueue(
  permissions: string[],
  overdue: unknown[] = [QUEUE_ROW],
  counts: Record<string, number> = { overdue: overdue.length, today: 0, tomorrow: 0, week: 0, upcoming: 0, awaiting: 0, completed: 0, completed_today: 0 },
): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
    user: { id: 'user-1', fullName: 'Asha Rep' },
  } as never);
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string, params?: unknown) => {
    if (url === '/follow-ups/counts') return Promise.resolve(counts as never);
    const bucket = (params as { bucket?: string } | undefined)?.bucket;
    return Promise.resolve((bucket === 'overdue' ? overdue : []) as never);
  });

  render(
    <QueryClientProvider client={newClient()}>
      <MemoryRouter>
        <FollowUpsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the follow-up queue', () => {
  it('logs a missed call from the row as ONE outcome request on that follow-up', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      leadId: QUEUE_ROW.leadId,
      outcome: 'NOT_ANSWERED',
      leadStatus: 'NEW',
      completedFollowUpId: null,
      followUp: null,
      nextFollowUpAt: '2026-10-22T05:30:00.000Z',
      replayed: false,
    } as never);
    renderQueue(['lead.update', 'followup.complete', 'followup.create']);

    await userEvent.click(await screen.findByRole('button', { name: /Log call outcome for Ravi Kulkarni/ }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Not answered$/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and schedule retry' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [url, body, options] = apiPost.mock.calls[0] ?? [];
    expect(url).toBe(`/leads/${QUEUE_ROW.leadId}/outcomes`);
    // The row's own follow-up — the one being worked — not "whichever is earliest".
    expect(body).toMatchObject({ outcome: 'NOT_ANSWERED', followUpId: QUEUE_ROW.id });
    expect((options as { headers: Record<string, string> }).headers['Idempotency-Key']).toMatch(
      /^[A-Za-z0-9_-]{8,100}$/,
    );
  });

  it('hides "Log outcome" from someone who may not update leads', async () => {
    renderQueue(['followup.complete']);

    await screen.findByText('Ravi Kulkarni');
    expect(screen.queryByRole('button', { name: /Log call outcome/ })).not.toBeInTheDocument();
  });

  it('shows TRUE totals on the tabs, not the length of a capped page', async () => {
    // 340 overdue, but only one row on this page: the tab must say 340.
    renderQueue(['lead.update'], [QUEUE_ROW], {
      overdue: 340, today: 4, tomorrow: 7, week: 12, upcoming: 30, awaiting: 5, completed: 900, completed_today: 3,
    });

    expect(await screen.findByText(/340 overdue/)).toBeInTheDocument();
    const tabs = within(screen.getByRole('tablist', { name: 'Follow-up buckets' }));
    expect(tabs.getByRole('tab', { name: /Overdues*340/ })).toBeInTheDocument();
    expect(tabs.getByRole('tab', { name: /Tomorrows*7/ })).toBeInTheDocument();
    expect(tabs.getByRole('tab', { name: /Awaiting responses*5/ })).toBeInTheDocument();
  });
});

// =============================================================================
// Customer (account) follow-ups in the queue
// =============================================================================

const CUSTOMER_ROW = {
  ...QUEUE_ROW,
  id: 'fu-acct-1',
  leadId: null,
  leadNumber: null,
  leadName: null,
  leadStatus: null,
  leadPriority: null,
  accountId: '01a00000-0000-7000-8000-0000000000aa',
  accountName: 'ABC Foods',
  companyName: 'ABC Foods',
};

describe('customer follow-ups in the queue', () => {
  it('links to the customer, not to /leads/null', async () => {
    renderQueue(['lead.update', 'followup.complete', 'followup.create'], [CUSTOMER_ROW]);

    const link = await screen.findByRole('link', { name: /ABC Foods/ });
    expect(link).toHaveAttribute('href', `/customers/${CUSTOMER_ROW.accountId}`);
    expect(screen.queryByRole('link', { name: /null/ })).not.toBeInTheDocument();
    expect(screen.getByText('Customer')).toBeInTheDocument();
  });

  it('offers no "No answer" on a customer row — there is no lead to log it on', async () => {
    renderQueue(['lead.update', 'followup.complete'], [CUSTOMER_ROW]);

    await screen.findByText('ABC Foods');
    expect(screen.queryByRole('button', { name: /No answer from/ })).not.toBeInTheDocument();
  });

  it('completes a customer follow-up without lead outcomes, and can finish it outright', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      followUp: { ...CUSTOMER_ROW, status: 'COMPLETED' },
      nextFollowUpAt: null,
    } as never);
    renderQueue(['followup.complete'], [CUSTOMER_ROW]);

    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }));
    const dialog = screen.getByRole('dialog');

    // Won and lost are LEAD outcomes; the API refuses them here.
    expect(within(dialog).queryByLabelText(/Mark the lead won/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText(/Nothing further for now/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Complete' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [url, body, options] = apiPost.mock.calls[0] ?? [];
    expect(url).toBe('/follow-ups/fu-acct-1/complete');
    expect(body).not.toHaveProperty('leadId');
    expect(body).not.toHaveProperty('nextFollowUpAt');
    expect(body).not.toHaveProperty('leadStatus');
    expect((options as { headers: Record<string, string> }).headers['Idempotency-Key']).toBeTruthy();
  });
});
