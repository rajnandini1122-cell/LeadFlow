import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LeadDetailPage } from '../features/leads/lead-detail-page';
import { LeadsPage } from '../features/leads/leads-page';
import { ApiError } from '../lib/api-client';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';
import type { LeadDetail } from '../features/leads/use-leads';

/**
 * Deactivation on screen.
 *
 * The defect behind this feature: a wrongly imported lead could not be taken
 * out of the pipeline in a way that said why. The only control was Archive,
 * which is a confirm box with no reason and no undo — so people left bad rows
 * in the pipeline or marked them LOST, which poisons loss analysis.
 *
 * Three claims here: the reason is not optional, a deactivated lead says so
 * loudly, and a reactivation that cannot happen explains which lead is in the
 * way.
 */

const LEAD: LeadDetail = {
  id: '01a00000-0000-7000-8000-000000000001',
  leadNumber: 'LD-00042',
  name: 'Dana Whitfield',
  companyName: 'Whitfield Foods',
  mobile: '+919820011001',
  email: 'dana@example.test',
  status: 'NEW',
  priority: 'MEDIUM',
  estimatedValue: '250000',
  nextFollowUpAt: '2026-11-20T09:00:00.000Z',
  assignedTo: { id: 'user-1', fullName: 'Asha Rep' },
  createdAt: '2026-10-01T09:00:00.000Z',
  deactivatedAt: null,
  activities: [],
  addressLine1: '12 High Street',
  addressLine2: null,
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411001',
  country: 'IN',
  deactivationReason: null,
  deactivatedBy: null,
  importBatchId: 'batch-1',
  market: 'DOMESTIC',
  lastOutcome: null,
  lastOutcomeAt: null,
  lastContactedAt: null,
  latestActivity: null,
  nextAction: null,
};

const DEACTIVATED: LeadDetail = {
  ...LEAD,
  deactivatedAt: '2026-10-10T09:00:00.000Z',
  deactivationReason: 'Wrong column mapping on the October import',
  deactivatedBy: 'user-2',
};

function signedInAs(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
    user: { id: 'user-1', fullName: 'Asha Admin' },
  } as never);
}

function stubApi(lead: LeadDetail): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
    if (url.startsWith('/leads/') && url.includes('/activities')) {
      return Promise.resolve({ items: [], hasMore: false } as never);
    }
    if (url.startsWith('/leads/') && url.includes('/follow-ups')) {
      return Promise.resolve([] as never);
    }
    if (url === '/leads/assignable-users') return Promise.resolve([] as never);
    if (url.startsWith('/leads/')) return Promise.resolve(lead as never);
    if (url === '/leads') {
      return Promise.resolve({ items: [lead], hasMore: false, nextCursor: null, total: 1 } as never);
    }
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

/**
 * The submit button INSIDE the open dialog.
 *
 * The page's "Deactivate" button and the dialog's are both correctly called
 * Deactivate — the first opens the form, the second submits it — so an
 * unscoped query matches two elements. Scoping to the dialog is what makes the
 * assertion about the one the user is actually looking at.
 */
const inDialog = (name: RegExp): HTMLElement =>
  within(screen.getByRole('dialog')).getByRole('button', { name });

beforeEach(() => {
  signedInAs(['lead.view.own', 'lead.update', 'lead.deactivate', 'lead.delete']);
});

describe('the lead detail', () => {
  it('shows the whole address, which the schema could not hold before', async () => {
    stubApi(LEAD);
    renderDetail();

    // Being able to SEE this is what lets somebody verify an import landed
    // correctly: the counts said "created 2,000" either way.
    expect(await screen.findByText('12 High Street, Pune, Maharashtra, 411001, IN')).toBeInTheDocument();
  });

  it('offers Deactivate and Archive as different actions', async () => {
    stubApi(LEAD);
    renderDetail();

    /*
     * Both, because they mean different things. Archive is irreversible and
     * records no reason; deactivation is the correction tool. Collapsing them
     * would mean either handing out irreversible deletion to clean up an
     * import, or leaving nobody able to.
     */
    expect(await screen.findByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });

  it('hides both from somebody without the permission', async () => {
    signedInAs(['lead.view.own']);
    stubApi(LEAD);
    renderDetail();

    await screen.findByText('Dana Whitfield');
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });
});

describe('deactivating', () => {
  it('requires a reason before the button does anything', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost');
    stubApi(LEAD);
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    /*
     * The submit button is DISABLED, not merely attached to a required input.
     *
     * The form carries `noValidate` — every dialog in this file does, so that
     * errors are rendered by the app rather than by the browser's own bubbles —
     * which means `required` alone does not stop a submit. Without the disabled
     * state the dialog posted `reason: ''` and relied on the server's 400,
     * which is a round trip to be told something the screen already knew.
     */
    expect(inDialog(/^Deactivate$/)).toBeDisabled();
    await userEvent.click(inDialog(/^Deactivate$/));

    // A record nobody explained is a record the next person cannot act on, so
    // the field is required rather than optional-with-a-nudge.
    expect(apiPost).not.toHaveBeenCalledWith(
      expect.stringContaining('/deactivate') as unknown as string,
      expect.anything(),
    );
  });

  it('sends the reason', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(LEAD as never);
    stubApi(LEAD);
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await userEvent.type(screen.getByLabelText(/Why/), 'Wrong column mapping');
    await userEvent.click(inDialog(/^Deactivate$/));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(`/leads/${LEAD.id}/deactivate`, {
        reason: 'Wrong column mapping',
      }),
    );
  });

  it('says what will and will not happen before it happens', async () => {
    stubApi(LEAD);
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));

    // The fear somebody has at this point is that it deletes the customer. The
    // dialog answers it directly, including that the number is freed — which is
    // the thing they are about to need.
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument();
    expect(screen.getByText(/mobile and email are freed/)).toBeInTheDocument();
  });
});

describe('a deactivated lead', () => {
  it('says so at the top, with the reason', async () => {
    stubApi(DEACTIVATED);
    renderDetail();

    /*
     * At the TOP, not in a corner. Somebody who opens a deactivated lead and
     * does not notice will waste a call on it, and the whole point of the state
     * is that the record should not be worked.
     */
    expect(await screen.findByText(/not in the pipeline/)).toBeInTheDocument();
    expect(
      screen.getByText(/Wrong column mapping on the October import/),
    ).toBeInTheDocument();
  });

  it('offers reactivation instead of deactivation', async () => {
    stubApi(DEACTIVATED);
    renderDetail();

    await screen.findByText(/not in the pipeline/);
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Reactivate/ }).length).toBeGreaterThan(0);
  });

  it('asks for a next action before coming back', async () => {
    const apiPost = vi.spyOn(apiClient, 'apiPost').mockResolvedValue(LEAD as never);
    stubApi(DEACTIVATED);
    renderDetail();

    await userEvent.click((await screen.findAllByRole('button', { name: /Reactivate it/ }))[0] as HTMLElement);

    /*
     * `leads_active_requires_followup` forbids a live lead with nothing to do.
     * The caller supplies the date rather than the server inventing one:
     * whoever puts the lead back knows when they mean to act on it, and a
     * server-chosen date is a reminder nobody agreed to.
     */
    expect(screen.getByLabelText(/Next follow-up/)).toBeInTheDocument();

    await userEvent.click(inDialog(/^Reactivate$/));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        `/leads/${LEAD.id}/reactivate`,
        expect.objectContaining({ nextFollowUpAt: expect.any(String) as unknown }),
      ),
    );
  });

  it('asks for no date when the lead was closed', async () => {
    stubApi({ ...DEACTIVATED, status: 'WON' });
    renderDetail();

    await userEvent.click((await screen.findAllByRole('button', { name: /Reactivate it/ }))[0] as HTMLElement);

    // WON and LOST are exempt from the constraint, so a lead deactivated while
    // closed comes back closed and needs nothing scheduled.
    expect(screen.queryByLabelText(/Next follow-up/)).toBeNull();
  });

  it('shows which lead is blocking a reactivation', async () => {
    stubApi(DEACTIVATED);
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(
      // (code, message, status) — the status is the THIRD argument, and
      // passing it first silently produced an ApiError whose message was the
      // error code.
      new ApiError(
        'DUPLICATE_LEAD',
        'Lead LD-00099 is now using this mobile number. Deal with that lead first, or clear the number on this one.',
        409,
      ),
    );
    renderDetail();

    await userEvent.click((await screen.findAllByRole('button', { name: /Reactivate it/ }))[0] as HTMLElement);
    await userEvent.click(inDialog(/^Reactivate$/));

    /*
     * The structural consequence of releasing the key: between deactivating
     * and reactivating, another lead may have taken the number. The server's
     * message NAMES that lead, and that name is the only actionable part — so
     * it is surfaced verbatim rather than replaced with "could not reactivate".
     */
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('LD-00099');
    expect(alert).toHaveTextContent(/Deal with that lead first/);
  });
});

describe('the leads list', () => {
  const renderList = (initialEntry = '/leads'): void => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <MemoryRouter initialEntries={[initialEntry]}>
          <LeadsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it('shows the pipeline by default', async () => {
    const apiGet = vi.spyOn(apiClient, 'apiGet');
    stubApi(LEAD);
    renderList();

    await screen.findByText('Dana Whitfield');

    // ACTIVE by default is what keeps a deactivated lead out of the working
    // pipeline and out of the total beside it.
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/leads',
        expect.objectContaining({ lifecycle: 'ACTIVE' }),
      ),
    );
  });

  it('offers the deactivated list as its own filter', async () => {
    const apiGet = vi.spyOn(apiClient, 'apiGet');
    stubApi(LEAD);
    renderList();

    await screen.findByText('Dana Whitfield');
    await userEvent.click(screen.getByRole('button', { name: 'Deactivated' }));

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/leads',
        expect.objectContaining({ lifecycle: 'INACTIVE' }),
      ),
    );
  });

  it('keeps that filter out of the status chips', async () => {
    stubApi(LEAD);
    renderList();

    await screen.findByText('Dana Whitfield');

    /*
     * Deactivated is not a pipeline stage — it is orthogonal to every stage,
     * and putting it beside New and Won would read as though it were one of
     * them. It sits on its own row under "Show".
     */
    expect(screen.getByText('Show')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'In the pipeline' })).toBeInTheDocument();
  });

  it('shows a whole import batch, deactivated rows included', async () => {
    const apiGet = vi.spyOn(apiClient, 'apiGet');
    stubApi(LEAD);
    renderList('/leads?importBatchId=batch-1');

    await screen.findByText('Dana Whitfield');

    /*
     * The screen exists to CORRECT a bad import, so it has to show what it is
     * about to act on. After somebody deactivates half the batch, a list that
     * hid those rows would make the work look undone.
     */
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/leads',
        expect.objectContaining({ importBatchId: 'batch-1', lifecycle: 'ALL' }),
      ),
    );
    expect(screen.getByText(/Showing one CSV import only/)).toBeInTheDocument();
  });
});
