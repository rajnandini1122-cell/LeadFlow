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
  country: null,
  market: 'DOMESTIC',
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

// =============================================================================
// Lead export carries what happened and what is next
// =============================================================================

describe('lead export', () => {
  it('includes last call, last spoke and next action columns', async () => {
    const { LeadsPage } = await import('../features/leads/leads-page');
    const csvModule = await import('../lib/export-csv');
    const download = vi.spyOn(csvModule, 'downloadCsv').mockImplementation(() => undefined);
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      can: () => true,
      user: { id: 'user-1', fullName: 'Asha Rep', organization: { slug: 'demo' } },
    } as never);
    vi.spyOn(apiClient, 'apiGet').mockResolvedValue({ items: [LEAD], hasMore: false, nextCursor: null, total: 1 } as never);

    wrap(<LeadsPage />, '/leads');
    await screen.findByText('Kavya Iyer');
    await userEvent.click(screen.getByRole('button', { name: 'Export loaded' }));

    const csv = download.mock.calls[0]?.[1] ?? '';
    // Line 1 is Excel's "sep=," hint; then the header row and the data.
    const [, header, row] = csv.split(/\r?\n/);
    expect(header).toContain('Last call outcome');
    expect(header).toContain('Next action due');
    expect(row).toContain('Not answered');
    expect(row).toContain('Retry call — no answer');
  });
});

// =============================================================================
// Dashboard
// =============================================================================

describe('the dashboard', () => {
  const DASH = {
    scope: 'ALL',
    timezone: 'Asia/Kolkata',
    followUps: { overdue: 3, dueToday: 5, upcoming: 9 },
    pipeline: {
      activeCount: 12,
      activeValue: '1250000',
      byStage: [
        { status: 'NEW', count: 4, value: '200000' },
        { status: 'QUALIFIED', count: 6, value: '800000' },
        { status: 'NEGOTIATION', count: 2, value: '250000' },
      ],
    },
    outcomes: { won: 3, lost: 1, wonValue: '400000', conversionRate: 75, newThisWeek: 4 },
    contacts: 20,
    nextActions: [],
    recent: [],
  };

  const render = async (workspace: unknown = { ...SUMMARY, scope: 'TEAM', leads: { ...SUMMARY.leads, unassigned: 2 } }) => {
    const { DashboardPage } = await import('../features/dashboard/dashboard-page');
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
      if (url === '/dashboard') return Promise.resolve(DASH as never);
      if (url === '/workspace/summary') return Promise.resolve(workspace as never);
      if (url === '/leads') return Promise.resolve({ items: [LEAD], hasMore: false, nextCursor: null, total: 1 } as never);
      return Promise.resolve([] as never);
    });
    wrap(<DashboardPage />);
    await screen.findByRole('region', { name: 'Key numbers' });
  };

  it('shows the key numbers, each linking to the list it counts', async () => {
    signedInAs(['lead.view.all', 'lead.create', 'lead.import', 'lead.update']);
    await render();

    const tiles = within(screen.getByRole('region', { name: 'Key numbers' }));
    expect(tiles.getByRole('link', { name: /Overdue\s*3/ })).toHaveAttribute('href', '/today?view=overdue');
    expect(tiles.getByRole('link', { name: /Due today\s*5/ })).toHaveAttribute('href', '/today?view=today');
    expect(await tiles.findByRole('link', { name: /Awaiting response\s*2/ })).toHaveAttribute('href', '/today?view=awaiting');
    expect(tiles.getByRole('link', { name: /Completed today\s*6/ })).toBeInTheDocument();
    expect(tiles.getByRole('link', { name: /Win rate\s*75%/ })).toHaveAttribute('href', '/leads?status=WON');
  });

  it('draws the pipeline as one bar per stage that opens that stage', async () => {
    signedInAs(['lead.view.all']);
    await render();

    const qualified = screen.getByRole('link', { name: /^Qualified: 6 leads/ });
    expect(qualified).toHaveAttribute('href', '/leads?status=QUALIFIED');
    // Count and value are written, not only drawn.
    expect(within(qualified).getByText('6')).toBeInTheDocument();
  });

  it('offers the primary actions in the header', async () => {
    signedInAs(['lead.view.all', 'lead.create', 'lead.import']);
    await render();

    expect(screen.getByRole('button', { name: '+ New lead' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import CSV' })).toHaveAttribute('href', '/leads/import');
    expect(screen.getByRole('link', { name: 'My work today' })).toHaveAttribute('href', '/today');
  });

  it('puts the work on the dashboard with its actions', async () => {
    signedInAs(['lead.view.all', 'lead.update', 'followup.create']);
    await render();

    expect(screen.getByRole('heading', { name: 'Today’s priorities' })).toBeInTheDocument();
    // Recent leads are actionable rows, not bare links.
    expect(await screen.findByRole('button', { name: /Log call outcome for Kavya Iyer/ })).toBeInTheDocument();
  });

  it('survives missing secondary numbers instead of crashing', async () => {
    signedInAs(['lead.view.all']);
    await render({});

    expect(within(screen.getByRole('region', { name: 'Key numbers' })).getByRole('link', { name: /Awaiting response\s*…/ })).toBeInTheDocument();
  });
});

// =============================================================================
// India vs international importers
// =============================================================================

describe('lead market', () => {
  it('tags an international lead with its country on the row', () => {
    signedInAs(['lead.update']);
    wrap(<ActionableLeadList leads={[{ ...LEAD, market: 'INTERNATIONAL', country: 'AE' }]} />);
    expect(screen.getByText('🌐 AE')).toBeInTheDocument();
  });

  it('tags a domestic lead as India', () => {
    signedInAs(['lead.update']);
    wrap(<ActionableLeadList leads={[LEAD]} />);
    expect(screen.getByText('India')).toBeInTheDocument();
  });

  it('filters the lead list by market through the API', async () => {
    const { LeadsPage } = await import('../features/leads/leads-page');
    signedInAs(['lead.view.all', 'lead.update']);
    const apiGet = vi
      .spyOn(apiClient, 'apiGet')
      .mockResolvedValue({ items: [], hasMore: false, nextCursor: null, total: 0 } as never);

    wrap(<LeadsPage />, '/leads');
    await userEvent.click(await screen.findByRole('button', { name: 'International' }));

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith('/leads', expect.objectContaining({ market: 'INTERNATIONAL' })),
    );
  });

  it('shows leads by market on the dashboard, each linking to its list', async () => {
    const { DashboardPage } = await import('../features/dashboard/dashboard-page');
    signedInAs(['lead.view.all']);
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string, params?: unknown) => {
      if (url === '/dashboard')
        return Promise.resolve({
          scope: 'ALL', timezone: 'Asia/Kolkata', followUps: { overdue: 0, dueToday: 0, upcoming: 0 },
          pipeline: { activeCount: 0, activeValue: '0', byStage: [] },
          outcomes: { won: 0, lost: 0, wonValue: '0', conversionRate: 0, newThisWeek: 0 },
          contacts: 0, nextActions: [], recent: [],
        } as never);
      if (url === '/leads') {
        const market = (params as { market?: string } | undefined)?.market;
        const total = market === 'DOMESTIC' ? 14 : market === 'INTERNATIONAL' ? 9 : market === 'UNKNOWN' ? 1 : 0;
        return Promise.resolve({ items: [], hasMore: false, nextCursor: null, total } as never);
      }
      return Promise.resolve(SUMMARY as never);
    });
    wrap(<DashboardPage />);

    expect(await screen.findByRole('link', { name: /International \(importers\)\s*9/ })).toHaveAttribute(
      'href',
      '/leads?market=INTERNATIONAL',
    );
    expect(screen.getByRole('link', { name: /India \(domestic\)\s*14/ })).toHaveAttribute('href', '/leads?market=DOMESTIC');
  });
});

// =============================================================================
// Due-date labels agree with the queues
// =============================================================================

describe('due-date labels', () => {
  afterEach(() => vi.useRealTimers());

  it('calls work earlier today "Overdue today", not "Due today"', async () => {
    const { formatDueDate } = await import('../lib/format');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T14:30:00.000Z')); // 20:00 IST

    // Due 11:00 IST today — already in the Overdue queue.
    expect(formatDueDate('2026-10-24T05:30:00.000Z')).toBe('Overdue today');
    // Due 22:00 IST today — still ahead.
    expect(formatDueDate('2026-10-24T16:30:00.000Z')).toBe('Due today');
  });

  it('cuts the day on the ORGANIZATION’s calendar, not the device’s', async () => {
    const { formatDueDate } = await import('../lib/format');
    vi.useFakeTimers();
    // 23:00 IST on the 24th = 17:30 UTC — still the 24th in IST.
    vi.setSystemTime(new Date('2026-10-24T17:30:00.000Z'));

    // 01:00 IST on the 25th is TOMORROW in IST (it is still the 24th in UTC).
    expect(formatDueDate('2026-10-24T19:30:00.000Z')).toBe('Due tomorrow');
  });

  it('paints anything past due red, as the Overdue queue counts it', () => {
    signedInAs(['lead.update']);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T14:30:00.000Z'));
    wrap(<ActionableLeadList leads={[{ ...LEAD, nextAction: { ...LEAD.nextAction!, scheduledAt: '2026-10-24T05:30:00.000Z', isOverdue: true } }]} />);

    expect(screen.getByText('Overdue today').className).toContain('text-red-700');
  });
});
