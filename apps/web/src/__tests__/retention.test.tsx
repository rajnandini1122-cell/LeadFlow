import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RetentionPage } from '../features/accounts/retention-page';
import { RepeatBusinessDialog } from '../features/accounts/repeat-business-dialog';
import * as apiClient from '../lib/api-client';

/**
 * Customer retention on screen.
 *
 * The tests that matter are the ones proving the screen does NOT act on its
 * own, and does not overstate what it knows:
 *
 *   - "no customer needs attention" is shown plainly, because a queue that
 *     always finds work is one nobody trusts
 *   - the previous won value is offered, never pre-filled
 *   - repeat business is not offered to a customer who has never bought
 *   - the queue says how many customers it actually examined
 */

vi.mock('../features/auth/auth-context', () => ({
  useAuth: () => ({ can: () => true }),
}));

function queueItem(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'a-1',
    name: 'ABC Foods',
    status: 'CUSTOMER',
    owner: { id: 'u-1', fullName: 'Dana' },
    headline: {
      kind: 'REPEAT_CANDIDATE',
      priority: 60,
      reason: 'Bought Garlic Powder 3 times. Last business 35 days ago.',
    },
    signals: [
      {
        kind: 'REPEAT_CANDIDATE',
        priority: 60,
        reason: 'Bought Garlic Powder 3 times. Last business 35 days ago.',
      },
    ],
    wonCount: 3,
    wonValue: 320000,
    openOpportunities: 0,
    lastWonAt: '2026-07-27T00:00:00.000Z',
    lastActivityAt: '2026-07-27T00:00:00.000Z',
    daysSinceActivity: 35,
    topProduct: { id: 'p-1', name: 'Garlic Powder' },
    ...overrides,
  };
}

function renderQueue(items: unknown[], extra: Record<string, unknown> = {}) {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((path: string) => {
    if (path.includes('retention/summary')) {
      return Promise.resolve({
        needAttention: items.length,
        repeatCandidates: 1,
        followUpsDue: 0,
        dormant: 0,
        expansionCandidates: 0,
        openCustomerOpportunities: 0,
        scanned: 10,
      } as never);
    }
    if (path.includes('retention/queue')) {
      return Promise.resolve({ items, total: 10, scanned: 10, ...extra } as never);
    }
    return Promise.resolve({ items: [] } as never);
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RetentionPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderRepeatDialog(products: unknown[]) {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((path: string) => {
    if (path.includes('repeat-options')) {
      return Promise.resolve({
        account: { id: 'a-1', name: 'ABC Foods', status: 'CUSTOMER' },
        products,
        contacts: [{ id: 'c-1', name: 'Rajesh', mobile: '+910000000001', email: null }],
      } as never);
    }
    return Promise.resolve({ items: [], total: 0, limit: 50, offset: 0 } as never);
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RepeatBusinessDialog accountId="a-1" accountName="ABC Foods" onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the action queue', () => {
  it('shows the customer, the reason and the action together', async () => {
    renderQueue([queueItem()]);

    expect(await screen.findByText('ABC Foods')).toBeInTheDocument();
    // The evidence, not just a label.
    expect(
      screen.getByText('Bought Garlic Powder 3 times. Last business 35 days ago.'),
    ).toBeInTheDocument();
    // The emoji distinguishes the ROW ACTION from the filter chip above, which
    // also reads "Repeat business".
    expect(screen.getByRole('button', { name: /🔄 Repeat business/ })).toBeInTheDocument();
  });

  it('says plainly when NOBODY needs attention', async () => {
    /*
     * The most important case. A queue that always finds work is one a
     * salesperson learns to ignore, and then the real signals are lost with
     * the invented ones.
     */
    renderQueue([]);

    expect(
      await screen.findByText(/No customer needs attention right now/i),
    ).toBeInTheDocument();
  });

  it('does NOT offer repeat business to a customer who has never bought', async () => {
    // A button that means nothing is worse than no button.
    renderQueue([
      queueItem({
        wonCount: 0,
        headline: { kind: 'DORMANT', priority: 80, reason: 'No recorded activity for 200 days.' },
        signals: [
          { kind: 'DORMANT', priority: 80, reason: 'No recorded activity for 200 days.' },
        ],
      }),
    ]);

    await screen.findByText('ABC Foods');

    expect(screen.queryByRole('button', { name: /🔄 Repeat business/ })).not.toBeInTheDocument();
    // A follow-up is still offered — that always applies.
    expect(screen.getByRole('button', { name: /📞 Follow-up/ })).toBeInTheDocument();
  });

  it('states how many customers it actually examined', async () => {
    /*
     * Signals come from history rather than anything SQL selects on, so the
     * queue filters within a page. Saying what it looked at beats implying it
     * saw every customer.
     */
    renderQueue([queueItem()], { total: 412, scanned: 50 });

    expect(
      await screen.findByText(/from 50 customers examined, of 412 in total/i),
    ).toBeInTheDocument();
  });

  it('lists the other reasons without burying the headline', async () => {
    renderQueue([
      queueItem({
        headline: { kind: 'FOLLOW_UP_DUE', priority: 100, reason: 'A follow-up is 4 days overdue.' },
        signals: [
          { kind: 'FOLLOW_UP_DUE', priority: 100, reason: 'A follow-up is 4 days overdue.' },
          { kind: 'REPEAT_CANDIDATE', priority: 60, reason: 'Last business 35 days ago.' },
        ],
      }),
    ]);

    expect(await screen.findByText('A follow-up is 4 days overdue.')).toBeInTheDocument();

    // Scoped to the ROW: the summary tile above also reads "Repeat business",
    // and an unscoped query cannot tell the two apart.
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Repeat business')).toBeInTheDocument();
  });
});

describe('the repeat business dialog', () => {
  const product = {
    productId: 'p-1',
    name: 'Garlic Powder',
    sku: 'GP-1',
    active: true,
    wins: 3,
    lastWonAt: '2026-07-27T00:00:00.000Z',
    lastWonValue: 85000,
    totalWonValue: 255000,
  };

  it('shows what they bought and what they paid', async () => {
    renderRepeatDialog([product]);

    expect(await screen.findByText('Garlic Powder')).toBeInTheDocument();
    expect(screen.getByText(/3 wins/)).toBeInTheDocument();
  });

  it('does NOT pre-fill the estimate with the previous won value', async () => {
    /*
     * An estimate is a forecast about THIS deal. Silently reusing last
     * quarter's price would destroy forecast accuracy as a measure, and nobody
     * would see it happen.
     */
    renderRepeatDialog([product]);

    await screen.findByText('Garlic Powder');

    const estimate = screen.getByLabelText(/Estimated value/i);
    expect(estimate).toHaveValue(null);
  });

  it('offers the previous value as an explicit choice', async () => {
    const user = userEvent.setup();
    renderRepeatDialog([product]);

    // Selecting the product is what surfaces its history.
    await user.click(await screen.findByRole('button', { name: /Garlic Powder/ }));

    const useIt = await screen.findByRole('button', { name: /Use that figure/i });
    expect(screen.getByText(/They last paid/)).toBeInTheDocument();

    await user.click(useIt);

    expect(screen.getByLabelText(/Estimated value/i)).toHaveValue(85000);
  });

  it('requires a next follow-up — no lead left behind', async () => {
    renderRepeatDialog([product]);

    await screen.findByText('Garlic Powder');
    expect(screen.getByLabelText(/Next follow-up/i)).toBeRequired();
  });

  it('says the customer is not re-entered', async () => {
    renderRepeatDialog([product]);

    await waitFor(() =>
      expect(
        screen.getByText(/Nothing about the customer is re-entered or duplicated/i),
      ).toBeInTheDocument(),
    );
  });
});
