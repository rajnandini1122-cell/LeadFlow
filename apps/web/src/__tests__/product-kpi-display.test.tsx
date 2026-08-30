import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductIntelligencePage } from '../features/products/product-intelligence-page';
import { formatKpi } from '../features/products/use-products';
import * as apiClient from '../lib/api-client';

/**
 * Product KPIs on screen.
 *
 * These figures get quoted in meetings, so the tests that matter are the ones
 * proving the page REFUSES to state something it cannot support: a win rate for
 * a product nothing has closed on, a percentage off a single sale, a growth
 * figure from two leads. A confident wrong number is worse than a dash.
 */

function row(overrides: Record<string, unknown> = {}) {
  return {
    productId: 'p-1',
    name: 'White Onion Powder',
    sku: 'WOP-1',
    category: 'Powders',
    active: true,
    totalLeads: 10,
    demandShare: 0.5,
    openLeads: 4,
    openPipeline: 100000,
    wonLeads: 3,
    wonValue: 60000,
    lostLeads: 1,
    lostValue: 10000,
    winRate: 0.75,
    winRateReliable: true,
    averageWonValue: 20000,
    averageDaysToClose: 21,
    forecast: { estimated: 65000, actual: 60000, variance: -5000, accuracy: 0.923 },
    trend: { current: 12, previous: 8, change: 0.5, direction: 'rising' },
    ...overrides,
  };
}

function mockApi(items: unknown[], totals: Record<string, number> = {}) {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((path: string) => {
    if (path.includes('performance')) {
      return Promise.resolve({
        items,
        totals: {
          productsWithDemand: items.length,
          leadsWithProduct: 10,
          leadsWithoutProduct: 0,
          ...totals,
        },
      } as never);
    }
    if (path.includes('by-source')) return Promise.resolve({ sources: [], items: [] } as never);
    if (path.includes('by-agent')) return Promise.resolve({ items: [] } as never);
    if (path.includes('loss-analysis')) return Promise.resolve({ items: [] } as never);
    return Promise.resolve({ items: [] } as never);
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProductIntelligencePage />
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

describe('formatKpi', () => {
  it('renders an em dash for a figure that cannot be calculated', () => {
    /*
     * The single most important formatter on the page. Printing "0" for
     * "nothing has closed yet" states something false about a product that
     * may be doing fine.
     */
    expect(formatKpi(null)).toBe('—');
    expect(formatKpi(undefined)).toBe('—');
    expect(formatKpi(null, 'percent')).toBe('—');
  });

  it('renders a real zero as zero', () => {
    // Genuinely none, and worth saying so.
    expect(formatKpi(0)).toBe('0');
    expect(formatKpi(0, 'percent')).toBe('0%');
  });

  it('renders a percentage from a fraction', () => {
    expect(formatKpi(0.75, 'percent')).toBe('75%');
  });
});

describe('the performance table', () => {
  it('shows a product’s figures', async () => {
    mockApi([row()]);
    renderPage();

    // Appears in both the trend panel and the table, which is correct.
    expect((await screen.findAllByText('White Onion Powder')).length).toBeGreaterThan(0);
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('shows a DASH where nothing has closed', async () => {
    mockApi([
      row({
        wonLeads: 0,
        lostLeads: 0,
        winRate: null,
        winRateReliable: false,
        wonValue: null,
        averageWonValue: null,
        averageDaysToClose: null,
        forecast: { estimated: null, actual: null, variance: null, accuracy: null },
      }),
    ]);
    renderPage();

    await screen.findAllByText('White Onion Powder');

    // Several columns cannot be computed, and all of them say so.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(2);
  });

  it('shows COUNTS instead of a percentage when too few deals have closed', async () => {
    /*
     * "100% win rate" off a single sale reads as excellent and means nothing.
     * The counts say exactly as much, honestly.
     */
    mockApi([
      row({ wonLeads: 1, lostLeads: 0, winRate: 1, winRateReliable: false }),
    ]);
    renderPage();

    expect(await screen.findByText('1/1')).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
  });

  it('marks a retired product without hiding its history', async () => {
    // Retiring a product must not remove it from last quarter's numbers.
    mockApi([row({ active: false })]);
    renderPage();

    expect(await screen.findByText('retired')).toBeInTheDocument();
    expect(screen.getAllByText('White Onion Powder').length).toBeGreaterThan(0);
  });
});

describe('the demand trend', () => {
  it('shows a percentage when the sample supports one', async () => {
    mockApi([row()]);
    renderPage();

    expect(await screen.findByText('+50%')).toBeInTheDocument();
  });

  it('shows COUNTS when the server withheld the percentage', async () => {
    /*
     * Two leads becoming three is "+50%", which reads as a trend and is noise.
     * The server sends change: null, and the page must not invent one.
     */
    mockApi([
      row({ trend: { current: 3, previous: 2, change: null, direction: 'rising' } }),
    ]);
    renderPage();

    expect(await screen.findByText('2 → 3')).toBeInTheDocument();
    expect(screen.queryByText('+50%')).not.toBeInTheDocument();
  });

  it('shows a product with no previous period as counts, not infinite growth', async () => {
    mockApi([row({ trend: { current: 9, previous: 0, change: null, direction: 'new' } })]);
    renderPage();

    expect(await screen.findByText('0 → 9')).toBeInTheDocument();
  });
});

describe('coverage', () => {
  it('states how many leads have NO product', async () => {
    /*
     * Every other figure covers only leads that have one. Without this, a
     * dashboard built on a fraction of the business looks like it covers all
     * of it.
     */
    mockApi([row()], { leadsWithoutProduct: 42 });
    renderPage();

    expect(await screen.findByText('Leads with none')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText(/not counted in anything below/i)).toBeInTheDocument();
  });

  it('says so plainly when nothing has a product yet', async () => {
    mockApi([]);
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/no leads have a product yet/i)).toBeInTheDocument(),
    );
  });
});
