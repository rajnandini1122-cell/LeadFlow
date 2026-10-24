import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';
import { setFormattingContext } from '../lib/format';
import { ToastProvider } from '../components/toast';
import { WorkspacePage } from '../features/workspace/workspace-page';
import { LogOutcomeDialog } from '../features/leads/log-outcome-dialog';
import { ActionableLeadList, nextActionText } from '../features/leads/actionable-lead-list';
import { RescheduleFollowUpDialog } from '../features/leads/lead-dialogs';
import type { LeadSummary } from '../features/leads/use-leads';
import type { WorkspaceSummary } from '../features/leads/use-lead-mutations';

/**
 * The sales workspace, on screen.
 *
 * What it must answer at a glance: what is due today, what is overdue, who did
 * not answer, who owes us a reply, and what to do next on every lead — with the
 * action one click away, and a confirmation that it happened.
 */

const newClient = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });

function signedInAs(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
    user: { id: 'user-1', fullName: 'Asha Rep' },
  } as never);
}

const wrap = (ui: React.ReactNode, path = '/') =>
  render(
    <QueryClientProvider client={newClient()}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const LEAD: LeadSummary = {
  id: '01a00000-0000-7000-8000-0000000000c1',
  leadNumber: 'LD-00101',
  name: 'Kavya Iyer',
  companyName: 'Iyer Spices',
  mobile: '+919820011101',
  status: 'CONTACTED',
  priority: 'HIGH',
  estimatedValue: '120000',
  nextFollowUpAt: '2026-10-24T05:30:00.000Z',
  assignedTo: { id: 'user-1', fullName: 'Asha Rep' },
  createdAt: '2026-10-01T05:30:00.000Z',
  deactivatedAt: null,
  lastOutcome: 'NOT_ANSWERED',
  lastOutcomeAt: '2026-10-23T05:30:00.000Z',
  lastContactedAt: null,
  latestActivity: { type: 'CALL_NOT_ANSWERED', description: 'Not answered — rang twice', at: '2026-10-23T05:30:00.000Z' },
  nextAction: {
    followUpId: '01a00000-0000-7000-8000-0000000000f1',
    type: 'CALL',
    title: 'Retry call — no answer',
    scheduledAt: '2026-10-24T05:30:00.000Z',
    assignedTo: { id: 'user-1', fullName: 'Asha Rep' },
    isOverdue: false,
  },
};

const SUMMARY: WorkspaceSummary = {
  timezone: 'Asia/Kolkata',
  scope: 'OWN',
  followUps: { overdue: 3, today: 5, tomorrow: 2, week: 4, upcoming: 9, awaiting: 2, completed: 40, completed_today: 6 },
  leads: { fresh: 7, awaiting: 2, unassigned: null },
};

beforeEach(() => {
  setFormattingContext({ locale: 'en-IN', currency: 'INR', timezone: 'Asia/Kolkata' });
});
afterEach(() => {
  vi.restoreAllMocks();
  setFormattingContext({ locale: 'en-US', currency: 'USD', timezone: 'UTC' });
});

// =============================================================================
// My work today
// =============================================================================

describe('My work today', () => {
  const stub = (summary = SUMMARY, rows: unknown[] = []) =>
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
      if (url === '/workspace/summary') return Promise.resolve(summary as never);
      if (url === '/leads') return Promise.resolve({ items: [], hasMore: false, nextCursor: null, total: 0 } as never);
      return Promise.resolve(rows as never);
    });

  it('shows every count from the server, one tile each', async () => {
    signedInAs(['lead.view.own', 'lead.update']);
    stub();
    wrap(<WorkspacePage />);

    const tiles = within(await screen.findByRole('tablist', { name: 'Work views' }));
    expect(await tiles.findByRole('tab', { name: /Calls due today\s*5/ })).toBeInTheDocument();
    expect(tiles.getByRole('tab', { name: /Overdue\s*3/ })).toBeInTheDocument();
    expect(tiles.getByRole('tab', { name: /Upcoming\s*9/ })).toBeInTheDocument();
    expect(tiles.getByRole('tab', { name: /Awaiting response\s*2/ })).toBeInTheDocument();
    expect(tiles.getByRole('tab', { name: /Completed today\s*6/ })).toBeInTheDocument();
    expect(tiles.getByRole('tab', { name: /New leads\s*7/ })).toBeInTheDocument();
    // A rep cannot see the whole team, so there is no Unassigned tile at all.
    expect(tiles.queryByRole('tab', { name: /Unassigned/ })).toBeNull();
    expect(screen.getByText(/Your leads · Asia\/Kolkata/)).toBeInTheDocument();
  });

  it('opens on Overdue when anything is overdue', async () => {
    signedInAs(['lead.view.own']);
    stub();
    wrap(<WorkspacePage />);

    const overdue = await screen.findByRole('tab', { name: /Overdue\s*3/ });
    await waitFor(() => expect(overdue).toHaveAttribute('aria-selected', 'true'));
  });

  it('opens on Today when nothing is overdue', async () => {
    signedInAs(['lead.view.own']);
    stub({ ...SUMMARY, followUps: { ...SUMMARY.followUps, overdue: 0 } });
    wrap(<WorkspacePage />);

    const today = await screen.findByRole('tab', { name: /Calls due today/ });
    await waitFor(() => expect(today).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByText('Nothing left today')).toBeInTheDocument();
  });

  it('opens the list behind a tile when it is clicked', async () => {
    signedInAs(['lead.view.own']);
    const apiGet = stub();
    wrap(<WorkspacePage />);

    await userEvent.click(await screen.findByRole('tab', { name: /Awaiting response/ }));

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith('/follow-ups', expect.objectContaining({ bucket: 'awaiting' })),
    );
    expect(await screen.findByText('Nobody owes you an answer')).toBeInTheDocument();
  });

  it('lists never-reached leads behind "New leads"', async () => {
    signedInAs(['lead.view.own']);
    const apiGet = stub();
    wrap(<WorkspacePage />, '/today?view=fresh');

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith('/leads', expect.objectContaining({ fresh: 'true' })),
    );
    expect(await screen.findByText('No untouched leads')).toBeInTheDocument();
  });

  it('offers Unassigned to someone who can see the whole team', async () => {
    signedInAs(['lead.view.all']);
    stub({ ...SUMMARY, scope: 'TEAM', leads: { ...SUMMARY.leads, unassigned: 4 } });
    wrap(<WorkspacePage />);

    expect(await screen.findByRole('tab', { name: /Unassigned\s*4/ })).toBeInTheDocument();
    expect(screen.getByText(/Whole team/)).toBeInTheDocument();
  });

  it('says so when the numbers cannot be loaded', async () => {
    signedInAs(['lead.view.own']);
    vi.spyOn(apiClient, 'apiGet').mockRejectedValue(new apiClient.ApiError('INTERNAL_ERROR', 'boom', 500));
    wrap(<WorkspacePage />);

    expect(await screen.findByText(/Could not load your work/)).toBeInTheDocument();
  });
});

// =============================================================================
// The actionable lead list
// =============================================================================

describe('actionable lead rows', () => {
  it('shows the last call, the latest interaction and the next action', () => {
    signedInAs(['lead.update', 'followup.create']);
    wrap(<ActionableLeadList leads={[LEAD]} />);

    expect(screen.getByText('Kavya Iyer')).toBeInTheDocument();
    // The outcome is NOT a stage: it carries the phone glyph and its own label.
    expect(screen.getByTitle(/Last call: Not answered/)).toBeInTheDocument();
    expect(screen.getByText('Not reached yet')).toBeInTheDocument();
    expect(screen.getByText(/rang twice/)).toBeInTheDocument();
    expect(screen.getByText('Retry call — no answer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Log call outcome for Kavya Iyer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reschedule next action for Kavya Iyer/ })).toBeInTheDocument();
  });

  it('labels each field on the phone layout', () => {
    signedInAs(['lead.update']);
    wrap(<ActionableLeadList leads={[LEAD]} />);
    // Cards repeat the column names, since the header row is desktop-only.
    for (const label of ['Last contact', 'Latest interaction', 'Next action']) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('hides work actions on a closed lead', () => {
    signedInAs(['lead.update', 'followup.create']);
    wrap(<ActionableLeadList leads={[{ ...LEAD, status: 'WON', nextAction: null }]} />);

    expect(screen.queryByRole('button', { name: /Log call outcome/ })).toBeNull();
    expect(screen.getByText('Closed — Won')).toBeInTheDocument();
  });

  it.each([
    [{ assignedTo: null, nextAction: null }, 'Assign an owner'],
    [{ nextAction: null }, 'Schedule the next action'],
    [{}, 'Retry call — no answer'],
  ])('derives the next action in words (%#)', (patch, text) => {
    expect(nextActionText({ ...LEAD, ...(patch as Partial<LeadSummary>) }).text).toBe(text);
  });

  it('marks an overdue next action as danger', () => {
    const next = nextActionText({ ...LEAD, nextAction: { ...LEAD.nextAction!, isOverdue: true } });
    expect(next.tone).toBe('danger');
  });
});

// =============================================================================
// The outcome dialog — what it sends
// =============================================================================

describe('the outcome dialog', () => {
  const open = (status: LeadSummary['status'] = 'CONTACTED') =>
    wrap(
      <LogOutcomeDialog lead={{ id: LEAD.id, name: LEAD.name, status }} followUpId="fu-9" open onClose={() => undefined} />,
    );
  const choose = async (label: RegExp) =>
    userEvent.click(within(screen.getByRole('dialog')).getByRole('radio', { name: label }));
  const ok = () =>
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      leadId: LEAD.id,
      outcome: 'X',
      leadStatus: 'QUALIFIED',
      completedFollowUpId: 'fu-9',
      followUp: null,
      nextFollowUpAt: '2026-10-25T05:30:00.000Z',
      replayed: false,
    } as never);

  it('sends a requirement with the qualify flag pre-ticked from CONTACTED', async () => {
    const apiPost = ok();
    open('CONTACTED');

    await choose(/requirement available/);
    expect(screen.getByLabelText('Mark the lead Qualified')).toBeChecked();
    await userEvent.type(screen.getByLabelText('What do they need?'), 'Onion flakes');
    await userEvent.type(screen.getByLabelText('Quantity'), '500 kg monthly');
    await userEvent.type(screen.getByLabelText('Expected purchase'), '2026-12-15');
    await userEvent.click(screen.getByRole('button', { name: 'Save outcome' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0]?.[1]).toMatchObject({
      outcome: 'CONNECTED_REQUIREMENT',
      followUpId: 'fu-9',
      markQualified: true,
      productInterest: 'Onion flakes',
      quantity: '500 kg monthly',
      expectedPurchaseDate: '2026-12-15',
      nextFollowUpAt: expect.any(String) as unknown,
    });
  });

  it('does not offer to qualify a lead already past Qualified', async () => {
    open('NEGOTIATION');
    await choose(/quotation requested/);
    expect(screen.queryByLabelText('Mark the lead Qualified')).toBeNull();
  });

  it('closes as Lost instead of scheduling, when the outcome allows it', async () => {
    const apiPost = ok();
    open();

    await choose(/^Not interested$/);
    await userEvent.click(screen.getByLabelText('Close the lead as Lost'));
    expect(screen.getByLabelText(/Why was it lost/)).toHaveValue('Not interested');
    await userEvent.click(screen.getByRole('button', { name: 'Save and close lead' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const body = apiPost.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body).toMatchObject({ outcome: 'NOT_INTERESTED', close: true, lostReason: 'Not interested' });
    expect(body).not.toHaveProperty('nextFollowUpAt');
  });

  it('reads the typed time in the organization timezone', async () => {
    const apiPost = ok();
    open();

    await choose(/call back later/);
    const when = screen.getByLabelText(/Next action/);
    await userEvent.clear(when);
    await userEvent.type(when, '2026-10-24T11:00');
    await userEvent.click(screen.getByRole('button', { name: 'Save outcome' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    // 11:00 IST is 05:30 UTC — whatever zone the device is in.
    expect((apiPost.mock.calls[0]?.[1] as Record<string, string>)['nextFollowUpAt']).toBe('2026-10-24T05:30:00.000Z');
  });

  it('confirms success out loud', async () => {
    ok();
    open();

    await choose(/^Busy$/);
    await userEvent.click(screen.getByRole('button', { name: 'Save and schedule retry' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/^.*Busy\. Next:/);
  });

  it('cannot be saved before an outcome is chosen', () => {
    open();
    expect(screen.getByRole('button', { name: 'Choose what happened' })).toBeDisabled();
  });
});

// =============================================================================
// Reschedule — shows what is moving, confirms where it went
// =============================================================================

describe('the reschedule dialog', () => {
  it('shows the current time and confirms the new one', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      id: 'fu-r2',
      scheduledAt: '2026-10-24T05:30:00.000Z',
    } as never);
    wrap(
      <RescheduleFollowUpDialog
        followUp={{ id: 'fu-r1', leadId: LEAD.id, scheduledAt: '2026-10-23T08:30:00.000Z', leadName: 'Kavya Iyer' }}
        open
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole('dialog', { name: /Kavya Iyer/ })).toBeInTheDocument();
    // 08:30 UTC is 2:00 pm IST.
    expect(screen.getByText(/Currently:/).textContent).toMatch(/2:00\s?pm/i);

    await userEvent.click(screen.getByRole('button', { name: 'Reschedule' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent(/Rescheduled to .*11:00\s?am/i);
  });
});
