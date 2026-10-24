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
  market: 'DOMESTIC',
  lastOutcome: null,
  lastOutcomeAt: null,
  lastContactedAt: null,
  latestActivity: null,
  nextAction: null,
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

describe('logging a call outcome from the lead page', () => {
  const openOutcome = async (): Promise<void> => {
    await userEvent.click(await screen.findByRole('button', { name: 'Log call outcome' }));
  };
  const choose = async (label: RegExp): Promise<void> => {
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('radio', { name: label }));
  };

  it('does NOT log a call when the Call button is pressed', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost');
    renderDetail();

    /*
     * THE DEFECT. Pressing Call posted "call completed" before anyone had
     * answered, so every unanswered dial became a completed call. Dialling now
     * opens the outcome dialog and records nothing until the agent says how it went.
     */
    await userEvent.click(await screen.findByRole('link', { name: 'Call' }));

    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('opens a form rather than logging straight away', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost');
    renderDetail();

    await openOutcome();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('sends a missed call as ONE outcome request, with the retry and the worked follow-up', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      leadId: LEAD.id,
      outcome: 'NOT_ANSWERED',
      leadStatus: 'QUALIFIED',
      completedFollowUpId: null,
      followUp: OPEN_FOLLOW_UP,
      nextFollowUpAt: '2026-11-21T09:00:00.000Z',
      replayed: false,
    } as never);
    renderDetail();

    await openOutcome();
    await choose(/^Not answered$/);
    await userEvent.type(screen.getByLabelText(/^Note/), 'Rang twice, voicemail');
    await userEvent.click(inDialog(/Save and schedule retry/));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        `/leads/${LEAD.id}/outcomes`,
        expect.objectContaining({
          outcome: 'NOT_ANSWERED',
          followUpId: OPEN_FOLLOW_UP.id,
          note: 'Rang twice, voicemail',
          nextFollowUpAt: expect.any(String) as unknown,
        }),
        // One Idempotency-Key per dialog opening, so a double click is ONE call.
        { headers: { 'Idempotency-Key': expect.stringMatching(/^[A-Za-z0-9_-]{8,100}$/) as unknown } },
      ),
    );
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('offers one-click retry times', async () => {
    renderDetail();
    await openOutcome();
    await choose(/^Not answered$/);

    const before = (screen.getByLabelText(/Try again/) as HTMLInputElement).value;
    await userEvent.click(inDialog(/Next week/));

    // The common answers without typing a datetime — the interaction a rep repeats all day.
    expect((screen.getByLabelText(/Try again/) as HTMLInputElement).value).not.toBe(before);
  });

  it('says the follow-up stays open and moves to the retry', async () => {
    renderDetail();
    await openOutcome();
    await choose(/^Busy$/);

    // So the rep is not left wondering whether they now have two, or none.
    expect(screen.getByTestId('outcome-consequence')).toHaveTextContent(
      /follow-up stays open and moves to the retry time/,
    );
  });

  it('states plainly that a missed call does not move the stage', async () => {
    renderDetail();
    await openOutcome();
    await choose(/^Not answered$/);

    expect(screen.getByTestId('outcome-consequence')).toHaveTextContent(
      /Stage stays at Qualified — nobody was reached/,
    );
  });

  it('offers no stage control for a missed call', async () => {
    renderDetail();
    await openOutcome();
    await choose(/^Switched off/);

    const dialog = within(screen.getByRole('dialog'));
    // Not merely unused — absent. The server refuses it for this outcome too.
    expect(dialog.queryByLabelText(/Mark the lead Qualified/i)).toBeNull();
    expect(dialog.queryByText(/Close the lead as Lost/i)).toBeNull();
  });

  it('asks for the requirement only on an outcome that has one', async () => {
    renderDetail();
    await openOutcome();

    await choose(/requirement available/);
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();

    await choose(/^Not answered$/);
    expect(screen.queryByLabelText('Quantity')).toBeNull();
  });

  it('surfaces a refusal rather than closing silently', async () => {
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
      new apiClient.ApiError('VALIDATION_ERROR', 'This lead is closed. Reopen it before logging another call.', 400),
    );
    renderDetail();

    await openOutcome();
    await choose(/^Not answered$/);
    await userEvent.click(inDialog(/Save and schedule retry/));

    expect(await screen.findByRole('alert')).toHaveTextContent(/This lead is closed/);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('forgets the previous answer when reopened', async () => {
    renderDetail();

    await openOutcome();
    await choose(/^Busy$/);
    await userEvent.click(inDialog(/Cancel/));
    await openOutcome();

    // A new call starts blank: nothing is chosen, so nothing can be saved by accident.
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('radio', { name: /^Busy$/ })).toHaveAttribute('aria-checked', 'false');
    expect(dialog.getByRole('button', { name: /Choose what happened/ })).toBeDisabled();
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
