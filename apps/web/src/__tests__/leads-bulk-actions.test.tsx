import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BulkActionBar,
  isSelected,
  selectionCount,
  toggleSelection,
  type LeadSelection,
} from '../features/leads/bulk-actions';
import * as apiClient from '../lib/api-client';

/**
 * Bulk lead actions: a selection model (ticked rows, or all matching minus
 * exclusions), and a bar that previews on the server before applying once.
 */

afterEach(() => vi.restoreAllMocks());

const SNAP = '2026-11-14T10:00:00.000Z';

describe('lead selection model', () => {
  it('ticks and unticks rows; empty clears the selection', () => {
    let s = toggleSelection(null, 'a');
    s = toggleSelection(s, 'b');
    expect(selectionCount(s, 10)).toBe(2);
    s = toggleSelection(toggleSelection(s, 'a'), 'b');
    expect(s).toBeNull();
  });

  it('"all matching" counts the total minus unticked rows', () => {
    let s: LeadSelection | null = { mode: 'query', excluded: new Set(), snapshotAt: SNAP };
    s = toggleSelection(s, 'x');
    expect(selectionCount(s, 37)).toBe(36);
    expect(isSelected(s, 'x')).toBe(false);
    expect(isSelected(s, 'y')).toBe(true);
  });
});

function renderBar(selection: LeadSelection, total = 3) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClear = vi.fn();
  const onSelectAllMatching = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <BulkActionBar
        selection={selection}
        total={total}
        filters={{ status: 'NEW', lifecycle: 'ACTIVE' }}
        canAssign
        onClear={onClear}
        onSelectAllMatching={onSelectAllMatching}
      />
    </QueryClientProvider>,
  );
  return { onClear, onSelectAllMatching };
}

const summary = (o: Partial<Record<string, number>>) => ({
  matched: 2,
  willChange: 0,
  changed: 0,
  unchanged: 0,
  refused: 0,
  conflicts: 0,
  ...o,
});

describe('BulkActionBar', () => {
  it('previews first, then applies once with an idempotency key, showing refusals with reasons', async () => {
    const post = vi.spyOn(apiClient, 'apiPost').mockImplementation(((
      _url: string,
      body: { dryRun: boolean },
    ) =>
      Promise.resolve({
        action: 'SET_PRIORITY',
        dryRun: body.dryRun,
        replayed: false,
        summary: body.dryRun
          ? summary({ willChange: 1, refused: 1 })
          : summary({ changed: 1, refused: 1 }),
        items: [
          { id: 'a', name: 'Rao Traders', outcome: body.dryRun ? 'WILL_CHANGE' : 'CHANGED' },
          {
            id: 'b',
            name: 'Pune Spice',
            outcome: 'REFUSED',
            reason: 'Schedule a next follow-up for this lead first.',
          },
        ],
      })) as never);
    const { onClear } = renderBar({ mode: 'ids', ids: new Set(['a', 'b']), snapshotAt: SNAP });

    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set priority' }));
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'HIGH');
    await userEvent.click(screen.getByRole('button', { name: 'Preview changes' }));

    expect(await screen.findByText(/1 will change/)).toBeInTheDocument();
    expect(screen.getByText(/Schedule a next follow-up/)).toBeInTheDocument();
    expect(post.mock.calls[0]).toEqual([
      '/leads/bulk',
      {
        dryRun: true,
        selection: { ids: ['a', 'b'], snapshotAt: SNAP },
        action: 'SET_PRIORITY',
        priority: 'HIGH',
      },
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Apply to 1' }));
    expect(await screen.findByText(/1 lead changed/)).toBeInTheDocument();
    const applied = post.mock.calls[1]!;
    expect(applied[1]).toMatchObject({ dryRun: false, action: 'SET_PRIORITY' });
    expect((applied[2] as { headers: Record<string, string> }).headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{32}$/,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClear).toHaveBeenCalled();
  });

  it('never offers Won as a bulk stage; Lost needs a reason', async () => {
    renderBar({ mode: 'ids', ids: new Set(['a']), snapshotAt: SNAP });
    await userEvent.click(screen.getByRole('button', { name: 'Change stage' }));
    const stage = screen.getByLabelText('New stage');
    expect([...stage.querySelectorAll('option')].map((o) => o.getAttribute('value'))).not.toContain(
      'WON',
    );
    await userEvent.selectOptions(stage, 'LOST');
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Why were they lost?'), 'Bought elsewhere');
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeEnabled();
  });

  it('"all matching" sends the current filters and the unticked rows, not ids', async () => {
    const post = vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      action: 'SET_PRIORITY',
      dryRun: true,
      replayed: false,
      summary: summary({ willChange: 36 }),
      items: [],
    } as never);
    renderBar({ mode: 'query', excluded: new Set(['x']), snapshotAt: SNAP }, 37);
    expect(screen.getByText('36 selected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set priority' }));
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'LOW');
    await userEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    expect(post.mock.calls[0]![1]).toMatchObject({
      selection: {
        query: { status: 'NEW', lifecycle: 'ACTIVE' },
        excludeIds: ['x'],
        snapshotAt: SNAP,
      },
    });
  });

  it('offers "select all matching" only within the bulk limit', () => {
    const { onSelectAllMatching } = renderBar(
      { mode: 'ids', ids: new Set(['a']), snapshotAt: SNAP },
      250,
    );
    const btn = screen.getByRole('button', { name: /narrow to 200/ });
    expect(btn).toBeDisabled();
    expect(onSelectAllMatching).not.toHaveBeenCalled();
  });
});
