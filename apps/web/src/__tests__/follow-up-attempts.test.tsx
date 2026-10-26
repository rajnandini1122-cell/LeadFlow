import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LeadDetailPage } from '../features/leads/lead-detail-page';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';
import type { LeadDetail } from '../features/leads/use-leads';

/**
 * "Could not reach them", on screen.
 *
 * The defect: "No answer" was one button that posted one activity row and
 * stopped. No retry was scheduled, the pending follow-up kept its date, and the
 * rep's reason went unrecorded unless they then typed a note and then opened the
 * reschedule dialog — three writes for one phone call.
 */

const LEAD: LeadDetail = {
  id: '01a00000-0000-7000-8000-000000000001',
  leadNumber: 'LD-00042',
  name: 'Dana Whitfield',
  companyName: 'Whitfield Foods',
  mobile: '+919820011001',
  email: 'dana@example.test',
  status: 'QUALIFIED',
  priority: 'MEDIUM',
  estimatedValue: '250000',
  nextFollowUpAt: '2026-11-20T09:00:00.000Z',
  assignedTo: { id: 'user-1', fullName: 'Asha Rep' },
  createdAt: '2026-10-01T09:00:00.000Z',
  deactivatedAt: null,
  activities: [],
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  country: null,
  deactivationReason: null,
  deactivatedBy: null,
  importBatchId: null,
};

const OPEN_FOLLOW_UP = {
  id: 'fu-1',
  leadId: LEAD.id,
  leadNumber: LEAD.leadNumber,
  leadName: LEAD.name,
  companyName: LEAD.companyName,
  mobile: LEAD.mobile,
  leadStatus: LEAD.status,
  leadPriority: LEAD.priority,
  estimatedValue: LEAD.estimatedValue,
  scheduledAt: '2026-11-20T09:00:00.000Z',
  type: 'CALL',
  status: 'UPCOMING',
  title: null,
  notes: null,
  outcome: null,
  completedAt: null,
  assignedTo: { id: 'user-1', fullName: 'Asha Rep' },
  isOverdue: false,
};

function signedInAs(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
    user: { id: 'user-1', fullName: 'Asha Rep' },
  } as never);
}

function stubApi(lead: LeadDetail, followUps: unknown[] = [OPEN_FOLLOW_UP]): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
    if (url.includes('/activities')) {
      return Promise.resolve({ items: [], hasMore: false } as never);
    }
    if (url.includes('/follow-ups')) return Promise.resolve(followUps as never);
    if (url === '/leads/assignable-users') return Promise.resolve([] as never);
    if (url.startsWith('/leads/')) return Promise.resolve(lead as never);
    return Promise.resolve([] as never);
  });
}

function renderDetail(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      })}
    >
      <MemoryRouter initialEntries={[`/leads/${LEAD.id}`]}>
        <Routes>
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/leads" element={<p>Leads list</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const inDialog = (name: RegExp): HTMLElement =>
  within(screen.getByRole('dialog')).getByRole('button', { name });

beforeEach(() => {
  signedInAs(['lead.view.own', 'lead.update', 'followup.create']);
  stubApi(LEAD);
});

describe('logging a failed attempt', () => {
  it('opens a form rather than logging straight away', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost');
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'No answer' }));

    /*
     * THE DEFECT. The button used to post immediately — one activity row, no
     * retry, nothing in the queue. Nothing is sent until the rep says when to
     * try again.
     */
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('starts on the answer the button meant', async () => {
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Call back later' }));

    expect(screen.getByLabelText(/What happened/)).toHaveValue('CALL_BACK_LATER');
  });

  it('sends the outcome, the note and the retry in one request', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      followUp: OPEN_FOLLOW_UP,
      nextFollowUpAt: '2026-11-21T09:00:00.000Z',
      leadStatus: 'QUALIFIED',
    } as never);
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'No answer' }));
    await userEvent.type(screen.getByLabelText(/^Note/), 'Rang twice, voicemail');
    await userEvent.click(inDialog(/Log and reschedule/));

    // ONE call for one phone call. Three facts, one commit.
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        `/leads/${LEAD.id}/attempts`,
        expect.objectContaining({
          activityType: 'CALL_NOT_ANSWERED',
          note: 'Rang twice, voicemail',
          retryAt: expect.any(String) as unknown,
        }),
        // One Idempotency-Key per dialog opening, so a double click is ONE attempt.
        { headers: { 'Idempotency-Key': expect.stringMatching(/^[A-Za-z0-9_-]{8,100}$/) as unknown } },
      ),
    );
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('offers one-click retry times', async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: 'No answer' }));

    const before = (screen.getByLabelText(/Try again/) as HTMLInputElement).value;
    await userEvent.click(inDialog(/In 2 hours/));

    // The common answers without typing a datetime, because this is the
    // interaction a rep repeats all day.
    expect((screen.getByLabelText(/Try again/) as HTMLInputElement).value).not.toBe(before);
  });

  it('says the retry replaces the pending follow-up', async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: 'No answer' }));

    // So the rep is not left wondering whether they now have two.
    expect(screen.getByText(/replaces the follow-up that is pending/)).toBeInTheDocument();
  });

  it('states plainly that the stage does not move', async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: 'No answer' }));

    /*
     * Said on the form, because the opposite is what a rep would assume — and
     * somebody expecting "No answer" to advance the lead should find out here
     * rather than from a wrong forecast three weeks later.
     */
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/An attempt nobody answered is not contact/)).toBeInTheDocument();
    // Scoped: the lead's own status badge on the page behind also says
    // "Qualified", which is correct for a user and ambiguous for a query.
    expect(dialog.getByText('Qualified')).toBeInTheDocument();
  });

  it('offers no status control at all', async () => {
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: 'No answer' }));

    const dialog = within(screen.getByRole('dialog'));
    // Not merely unused — absent. The endpoint accepts none either.
    expect(dialog.queryByLabelText(/status/i)).toBeNull();
    expect(dialog.queryByText(/Mark the lead/i)).toBeNull();
  });

  it('surfaces a refusal rather than closing silently', async () => {
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
      new apiClient.ApiError(
        'VALIDATION_ERROR',
        'This lead is closed. Reopen it before logging another attempt.',
        400,
      ),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'No answer' }));
    await userEvent.click(inDialog(/Log and reschedule/));

    expect(await screen.findByRole('alert')).toHaveTextContent(/This lead is closed/);
  });

  it('forgets the previous answer when reopened', async () => {
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Call back later' }));
    await userEvent.click(inDialog(/Cancel/));
    await userEvent.click(screen.getByRole('button', { name: 'No answer' }));

    // Reopening from a different button must not keep the first one's answer.
    expect(screen.getByLabelText(/What happened/)).toHaveValue('CALL_NOT_ANSWERED');
  });
});

describe('the follow-ups card', () => {
  it('counts the open follow-ups', async () => {
    renderDetail();

    expect(await screen.findByText('1 open')).toBeInTheDocument();
  });

  it('explains a zero count on an unassigned lead', async () => {
    stubApi({ ...LEAD, assignedTo: null }, []);
    renderDetail();

    /*
     * "0 open" beside a next-action date read as a bug, and usually WAS one —
     * four paths set the date and created no follow-up row. That is fixed at
     * the source. What remains legitimately is an unassigned lead, where
     * `assigned_user_id` is NOT NULL so no follow-up can exist. Saying so beats
     * a bare zero that looks like data loss.
     */
    expect(await screen.findByText(/Nobody owns this lead yet/)).toBeInTheDocument();
    expect(screen.getByText('Not assigned')).toBeInTheDocument();
  });

  it('shows the ordinary empty state for an assigned lead', async () => {
    stubApi({ ...LEAD, nextFollowUpAt: null }, []);
    renderDetail();

    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
    expect(screen.queryByText(/Nobody owns this lead/)).toBeNull();
  });
});
