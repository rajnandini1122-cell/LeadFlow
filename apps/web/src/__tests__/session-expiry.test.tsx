import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as apiClient from '../lib/api-client';
import { ToastProvider } from '../components/toast';
import { LogOutcomeDialog, clearOutcomeDraft, readOutcomeDraft } from '../features/leads/log-outcome-dialog';
import { returnPath } from '../features/auth/login-page';

/**
 * A session that ends mid-entry must not cost the rep what they typed, and
 * signing in again must bring them back to where they were.
 */

const LEAD = { id: '01a00000-0000-7000-8000-0000000000c1', name: 'Kavya Iyer', status: 'CONTACTED' as const };

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const dialog = () => within(screen.getByRole('dialog'));

beforeEach(() => clearOutcomeDraft(LEAD.id));
afterEach(() => {
  vi.restoreAllMocks();
  clearOutcomeDraft(LEAD.id);
});

describe('return to where the session ended', () => {
  it('goes back to the in-app page, and only to an in-app page', () => {
    expect(returnPath({ from: '/leads/abc?tab=files' })).toBe('/leads/abc?tab=files');
    expect(returnPath(null)).toBe('/today');
    expect(returnPath({ from: 'https://evil.example/' })).toBe('/today');
    expect(returnPath({ from: '//evil.example/' })).toBe('/today');
    expect(returnPath({ from: '/login' })).toBe('/today');
    expect(returnPath({ from: 42 })).toBe('/today');
  });
});

describe('typing in a dialog while the page behind it refreshes', () => {
  it('keeps focus and every keystroke when the parent re-renders with a new onClose', async () => {
    const { Dialog } = await import('../features/leads/lead-dialogs');
    const user = userEvent.setup();
    const ui = (n: number) => (
      <Dialog open title="Note" onClose={() => n /* a new function every render */}>
        <button type="button">First</button>
        <textarea aria-label="Body" />
      </Dialog>
    );
    const view = render(ui(0));
    const body = screen.getByLabelText('Body');
    await user.click(body);
    await user.keyboard('ab');
    view.rerender(ui(1)); // e.g. the queue behind refetched
    await user.keyboard('c');
    view.rerender(ui(2));
    await user.keyboard('d');
    expect(body).toHaveValue('abcd');
    expect(body).toHaveFocus();
  });
});

describe('call outcome draft', () => {
  it('survives the dialog disappearing (session ended) and comes back on reopen', async () => {
    const first = wrap(<LogOutcomeDialog lead={LEAD} open onClose={() => undefined} />);
    await userEvent.click(dialog().getByRole('radio', { name: /^Not answered/ }));
    await userEvent.type(dialog().getByLabelText(/^Note/), 'Rang twice, try after lunch');
    await waitFor(() => expect(readOutcomeDraft(LEAD.id)?.note).toBe('Rang twice, try after lunch'));
    first.unmount(); // what a sign-out redirect does to an open dialog

    wrap(<LogOutcomeDialog lead={LEAD} open onClose={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('Restored what you entered before');
    expect(dialog().getByRole('radio', { name: /^Not answered/ })).toHaveAttribute('aria-checked', 'true');
    expect(dialog().getByLabelText(/^Note/)).toHaveValue('Rang twice, try after lunch');
  });

  it('a deliberate Cancel discards the draft', async () => {
    const onClose = vi.fn();
    wrap(<LogOutcomeDialog lead={LEAD} open onClose={onClose} />);
    await userEvent.click(dialog().getByRole('radio', { name: /^Busy/ }));
    await waitFor(() => expect(readOutcomeDraft(LEAD.id)).not.toBeNull());
    await userEvent.click(dialog().getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(readOutcomeDraft(LEAD.id)).toBeNull();
  });

  it('a successful save discards the draft', async () => {
    vi.spyOn(apiClient, 'apiPost').mockResolvedValue({
      leadId: LEAD.id, outcome: 'BUSY', leadStatus: 'CONTACTED', completedFollowUpId: null,
      nextFollowUpAt: '2026-10-25T08:30:00.000Z', replayed: false,
    } as never);
    wrap(<LogOutcomeDialog lead={LEAD} open onClose={() => undefined} />);
    await userEvent.click(dialog().getByRole('radio', { name: /^Busy/ }));
    await userEvent.click(dialog().getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(readOutcomeDraft(LEAD.id)).toBeNull());
  });

  it('a failed save (session ended during save) keeps the draft', async () => {
    vi.spyOn(apiClient, 'apiPost').mockRejectedValue(new apiClient.ApiError('UNAUTHORIZED' as never, 'Session expired', 401));
    wrap(<LogOutcomeDialog lead={LEAD} open onClose={() => undefined} />);
    await userEvent.click(dialog().getByRole('radio', { name: /^Busy/ }));
    await userEvent.type(dialog().getByLabelText(/^Note/), 'Engaged tone');
    await userEvent.click(dialog().getByRole('button', { name: /^Save/ }));
    await screen.findByText('Session expired');
    expect(readOutcomeDraft(LEAD.id)).toMatchObject({ outcome: 'BUSY', note: 'Engaged tone' });
  });

  it('an outcome chosen from a queue button is not overridden by an old draft', async () => {
    const first = wrap(<LogOutcomeDialog lead={LEAD} open onClose={() => undefined} />);
    await userEvent.click(dialog().getByRole('radio', { name: /^Busy/ }));
    await waitFor(() => expect(readOutcomeDraft(LEAD.id)).not.toBeNull());
    first.unmount();

    wrap(<LogOutcomeDialog lead={LEAD} open onClose={() => undefined} initialOutcome="NOT_ANSWERED" />);
    expect(dialog().getByRole('radio', { name: /^Not answered/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText(/Restored what you entered/)).not.toBeInTheDocument();
  });
});
