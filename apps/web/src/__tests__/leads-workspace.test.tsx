import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewTabs, sameView, viewParams } from '../features/leads/lead-views';
import { LeadKanban } from '../features/leads/lead-kanban';
import type { LeadSummary } from '../features/leads/use-leads';
import * as apiClient from '../lib/api-client';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => window.localStorage.clear());

describe('saved views', () => {
  it('offers All, My leads, Overdue and Unassigned; selecting one applies its filters', async () => {
    const onSelect = vi.fn();
    render(<ViewTabs userId="u1" canSeeTeam current={{}} onSelect={onSelect} />);
    for (const name of ['All leads', 'My leads', 'Overdue', 'Unassigned']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'All leads' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Overdue' }));
    expect(onSelect).toHaveBeenCalledWith({ overdue: 'true' });
    await userEvent.click(screen.getByRole('button', { name: 'My leads' }));
    expect(onSelect).toHaveBeenLastCalledWith({ owner: 'u1' });
  });

  it('saves the current filters as a named view, and deletes it', async () => {
    render(
      <ViewTabs
        userId="u1"
        canSeeTeam={false}
        current={{ status: 'NEW', fresh: 'true' }}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Unassigned' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '+ Save this view' }));
    await userEvent.type(screen.getByLabelText('View name'), 'Fresh new');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Fresh new' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete view Fresh new' }));
    expect(screen.queryByRole('button', { name: 'Fresh new' })).not.toBeInTheDocument();
  });

  it('reads only view filters from the URL', () => {
    const p = new URLSearchParams('overdue=true&mode=kanban&owner=u1');
    expect(viewParams(p)).toEqual({ overdue: 'true', owner: 'u1' });
    expect(sameView({ a: '1' }, { a: '1' })).toBe(true);
  });
});

const lead = (over: Partial<LeadSummary>): LeadSummary =>
  ({
    id: 'l1',
    leadNumber: 'L-1',
    name: 'Rao Traders',
    companyName: 'Rao Traders',
    mobile: null,
    status: 'NEW',
    priority: 'HIGH',
    estimatedValue: null,
    nextFollowUpAt: null,
    assignedTo: null,
    createdAt: '2026-11-14T00:00:00.000Z',
    deactivatedAt: null,
    country: null,
    market: 'UNKNOWN',
    lastOutcome: null,
    lastOutcomeAt: null,
    lastContactedAt: null,
    latestActivity: null,
    nextAction: null,
    ...over,
  }) as LeadSummary;

function renderKanban(leads: LeadSummary[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LeadKanban leads={leads} counts={{ NEW: 100, CONTACTED: 11 }} onOpen={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Kanban', () => {
  it('shows every stage with its server count', () => {
    renderKanban([lead({})]);
    expect(screen.getByRole('region', { name: 'New column' })).toHaveTextContent('100');
    expect(screen.getByRole('region', { name: 'Contacted column' })).toHaveTextContent('11');
  });

  it('a move is previewed, then applied through the bulk API for that one lead', async () => {
    const post = vi.spyOn(apiClient, 'apiPost').mockImplementation(((
      _url: string,
      body: { dryRun?: boolean },
    ) =>
      Promise.resolve({
        action: 'SET_STATUS',
        dryRun: Boolean(body.dryRun),
        replayed: false,
        snapshotAt: '2026-11-14T10:00:00.000Z',
        summary: {},
        items: [
          { id: 'l1', name: 'Rao Traders', outcome: body.dryRun ? 'WILL_CHANGE' : 'CHANGED' },
        ],
      })) as never);
    renderKanban([lead({})]);
    await userEvent.selectOptions(screen.getByLabelText('Move Rao Traders to'), 'CONTACTED');
    expect(await screen.findByRole('status')).toHaveTextContent('Rao Traders moved to Contacted');
    expect(post.mock.calls[0]![1]).toMatchObject({
      dryRun: true,
      status: 'CONTACTED',
      selection: { ids: ['l1'] },
    });
    expect(post.mock.calls[1]![1]).toMatchObject({
      status: 'CONTACTED',
      selection: { ids: ['l1'], snapshotAt: '2026-11-14T10:00:00.000Z' },
    });
  });

  it('a move the rules refuse shows the reason and changes nothing', async () => {
    const post = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      action: 'SET_STATUS',
      dryRun: true,
      replayed: false,
      snapshotAt: 'x',
      summary: {},
      items: [
        {
          id: 'l1',
          name: 'Rao Traders',
          outcome: 'REFUSED',
          reason: 'An open lead needs a next follow-up date.',
        },
      ],
    } as never);
    renderKanban([lead({})]);
    await userEvent.selectOptions(screen.getByLabelText('Move Rao Traders to'), 'QUALIFIED');
    expect(await screen.findByRole('alert')).toHaveTextContent('needs a next follow-up');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('Lost asks for a reason first', async () => {
    renderKanban([lead({})]);
    await userEvent.selectOptions(screen.getByLabelText('Move Rao Traders to'), 'LOST');
    expect(screen.getByRole('button', { name: 'Mark lost' })).toBeDisabled();
  });
});
