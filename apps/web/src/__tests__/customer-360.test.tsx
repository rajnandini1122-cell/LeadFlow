import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Customer360Page } from '../features/accounts/customer-360-page';
import { CustomerKpiPage } from '../features/accounts/customer-kpi-page';
import { formatCustomerKpi } from '../features/accounts/use-accounts';
import * as apiClient from '../lib/api-client';

/**
 * Customer 360 and customer KPIs on screen.
 *
 * The tests that matter are the ones proving the page REFUSES to state
 * something it cannot support: a repeat rate off three customers, an average
 * deal value for a customer who has never bought, a product breakdown that
 * hides how much of the business it does not cover.
 *
 * A confident wrong number is worse than a dash, because somebody acts on it.
 */

vi.mock('../features/auth/auth-context', () => ({
  useAuth: () => ({ can: () => true }),
}));

function customer(overrides: Record<string, unknown> = {}) {
  return {
    account: {
      id: 'a-1',
      name: 'ABC Foods',
      status: 'CUSTOMER',
      industry: 'Food manufacturing',
      website: 'abcfoods.com',
      domain: 'abcfoods.com',
      phone: null,
      email: null,
      city: 'Pune',
      state: null,
      country: null,
      source: null,
      notes: null,
      owner: { id: 'u-1', fullName: 'Dana Whitfield' },
      firstContactAt: '2025-01-01T00:00:00.000Z',
      firstWonAt: '2025-03-01T00:00:00.000Z',
      lastWonAt: '2026-06-01T00:00:00.000Z',
      lastActivityAt: '2026-08-01T00:00:00.000Z',
      active: true,
    },
    contacts: { items: [], total: 0 },
    openOpportunities: { items: [], total: 0 },
    closedOpportunities: { items: [], total: 0 },
    commercial: {
      basis: 'crm-opportunities',
      wonCount: 3,
      wonValue: 320000,
      averageDealValue: 106666,
      lostCount: 1,
      lostEstimatedValue: 40000,
      openCount: 1,
      openPipeline: 90000,
      firstWonAt: '2025-03-01T00:00:00.000Z',
      lastWonAt: '2026-06-01T00:00:00.000Z',
      repeatOrderCount: 2,
      isRepeatCustomer: true,
    },
    products: { items: [], leadsWithoutProduct: 0 },
    conversations: { items: [], total: 0 },
    activities: { items: [], total: 0 },
    followUps: [],
    crossSell: [],
    ...overrides,
  };
}

function renderCustomer(data: Record<string, unknown>) {
  vi.spyOn(apiClient, 'apiGet').mockResolvedValue(data as never);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/customers/a-1']}>
        <Routes>
          <Route path="/customers/:id" element={<Customer360Page />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderKpis(overview: Record<string, unknown>, demand?: Record<string, unknown>) {
  vi.spyOn(apiClient, 'apiGet').mockImplementation((path: string) => {
    if (path.includes('overview')) return Promise.resolve(overview as never);
    if (path.includes('product-demand')) {
      return Promise.resolve(
        (demand ?? {
          items: [],
          totals: { prospect: 0, existingCustomer: 0, unknown: 0, total: 0, existingCustomerShare: null },
          coverage: { leadsWithoutProduct: 0, leadsWithoutAccount: 0 },
        }) as never,
      );
    }
    return Promise.resolve({ items: [] } as never);
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CustomerKpiPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function overview(overrides: Record<string, unknown> = {}) {
  return {
    counts: { prospects: 20, customers: 8, dormant: 1, formerCustomers: 1, total: 30 },
    newCustomers: 3,
    conversionRate: 0.33,
    repeat: {
      customersWithAnyWin: 10,
      customersWithMultipleWins: 4,
      repeatRate: 0.4,
      averageWinsPerCustomer: 1.6,
    },
    value: {
      totalWonValue: 1000000,
      averageCustomerValue: 100000,
      repeatWonValue: 400000,
      repeatRevenueShare: 0.4,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatCustomerKpi', () => {
  it('renders an em dash for a figure that cannot be calculated', () => {
    /*
     * The single most important formatter here. "No customer has bought twice
     * yet" and "the repeat rate is 0%" describe completely different
     * businesses, and only one of them is a problem.
     */
    expect(formatCustomerKpi(null)).toBe('—');
    expect(formatCustomerKpi(undefined)).toBe('—');
    expect(formatCustomerKpi(null, 'percent')).toBe('—');
    expect(formatCustomerKpi(null, 'currency')).toBe('—');
  });

  it('renders a real zero as zero', () => {
    // Genuinely none, and worth saying so.
    expect(formatCustomerKpi(0)).toBe('0');
    expect(formatCustomerKpi(0, 'percent')).toBe('0%');
  });

  it('renders a percentage from a fraction', () => {
    expect(formatCustomerKpi(0.4, 'percent')).toBe('40%');
  });
});

describe('Customer 360', () => {
  it('shows the relationship, not just the latest deal', async () => {
    renderCustomer(customer());

    expect(await screen.findByText('ABC Foods')).toBeInTheDocument();
    expect(screen.getByText(/Repeat customer · 3 deals/)).toBeInTheDocument();
  });

  it('says the figures are CRM opportunities, not invoiced revenue', async () => {
    /*
     * LeadFlow has no order table. Letting these read as invoiced revenue
     * would be a lie that gets quoted in a meeting.
     */
    renderCustomer(customer());

    expect(
      await screen.findByText(/CRM opportunities, not invoiced revenue/i),
    ).toBeInTheDocument();
  });

  it('shows a DASH for the average deal when nothing has been won', async () => {
    renderCustomer(
      customer({
        commercial: {
          basis: 'crm-opportunities',
          wonCount: 0,
          wonValue: 0,
          averageDealValue: null,
          lostCount: 0,
          lostEstimatedValue: 0,
          openCount: 2,
          openPipeline: 50000,
          firstWonAt: null,
          lastWonAt: null,
          repeatOrderCount: 0,
          isRepeatCustomer: false,
        },
      }),
    );

    await screen.findByText('ABC Foods');

    expect(screen.getByText('Never bought')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('does NOT call a one-deal customer a repeat customer', async () => {
    renderCustomer(
      customer({
        commercial: {
          ...customer().commercial,
          wonCount: 1,
          repeatOrderCount: 0,
          isRepeatCustomer: false,
        },
      }),
    );

    await screen.findByText('ABC Foods');
    expect(screen.queryByText(/Repeat customer/)).not.toBeInTheDocument();
  });

  it('states how many opportunities have NO product', async () => {
    /*
     * A customer with two mapped leads out of forty is not a two-product
     * customer, and without this figure they would look like one.
     */
    renderCustomer(
      customer({
        products: {
          items: [
            {
              productId: 'p-1',
              name: 'Garlic Powder',
              sku: 'GP-1',
              category: null,
              active: true,
              enquiries: 2,
              won: 1,
              wonValue: 100000,
              lost: 0,
              open: 1,
            },
          ],
          leadsWithoutProduct: 12,
        },
      }),
    );

    expect(await screen.findByText(/12 opportunities have no product/i)).toBeInTheDocument();
  });

  it('keeps the free-text enquiry beside the standardised product', async () => {
    renderCustomer(
      customer({
        openOpportunities: {
          items: [
            {
              id: 'l-1',
              leadNumber: 'LD-000001',
              name: 'Rajesh',
              status: 'QUALIFIED',
              priority: 'HIGH',
              source: 'IndiaMART',
              estimatedValue: 90000,
              wonValue: null,
              wonAt: null,
              lostAt: null,
              lostReason: null,
              nextFollowUpAt: null,
              lastActivityAt: null,
              createdAt: '2026-08-01T00:00:00.000Z',
              product: { id: 'p-1', name: 'Garlic Powder', sku: 'GP-1' },
              productInterest: '500 kg monthly, food manufacturing use',
              assignedTo: null,
              contact: null,
            },
          ],
          total: 1,
        },
      }),
    );

    // Both. The catalogue entry cannot carry what they actually asked for.
    expect(await screen.findByText('Garlic Powder')).toBeInTheDocument();
    expect(
      screen.getByText('500 kg monthly, food manufacturing use'),
    ).toBeInTheDocument();
  });

  it('does not offer to mark a prospect a customer', async () => {
    /*
     * That transition is earned by winning an opportunity, and the server
     * refuses it. Offering a control that always fails would be worse than
     * offering none.
     */
    renderCustomer(
      customer({ account: { ...customer().account, status: 'PROSPECT' } }),
    );

    await screen.findByText('ABC Foods');

    const select = screen.getByLabelText('Change customer status');
    expect(select).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Mark customer/i })).not.toBeInTheDocument();
  });
});

describe('Customer KPIs', () => {
  it('shows the repeat rate when the sample supports one', async () => {
    renderKpis(overview());

    // 40% appears twice — the repeat RATE and the repeat REVENUE share are
    // both 0.4 in this fixture, which is exactly the sort of ambiguity a
    // getByText would hide.
    expect(await screen.findByText('4 of 10')).toBeInTheDocument();
    expect(screen.getAllByText('40%')).toHaveLength(2);
  });

  it('shows a DASH and says why when the sample is too small', async () => {
    /*
     * Two customers where one bought twice is "50% repeat rate", which reads
     * as a finding and is a coin toss. The server sends null; the page must
     * not invent one, and must explain the gap.
     */
    renderKpis(
      overview({
        repeat: {
          customersWithAnyWin: 2,
          customersWithMultipleWins: 1,
          repeatRate: null,
          averageWinsPerCustomer: 1.5,
        },
      }),
    );

    expect(
      await screen.findByText(/Too few paying customers for a percentage/i),
    ).toBeInTheDocument();
  });

  it('splits product demand into prospects, customers and unattributed', async () => {
    renderKpis(overview(), {
      items: [
        {
          productId: 'p-1',
          name: 'Garlic Powder',
          sku: 'GP-1',
          category: null,
          active: true,
          prospect: 42,
          existingCustomer: 31,
          unknown: 7,
          total: 80,
          existingCustomerShare: 0.42,
        },
      ],
      totals: {
        prospect: 42,
        existingCustomer: 31,
        unknown: 7,
        total: 80,
        existingCustomerShare: 0.42,
      },
      coverage: { leadsWithoutProduct: 5, leadsWithoutAccount: 7 },
    });

    expect(await screen.findByText('Garlic Powder')).toBeInTheDocument();
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
    expect(screen.getAllByText('31').length).toBeGreaterThan(0);
    // Unattributed is shown, never folded into either side.
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
  });

  it('states coverage so a partial breakdown cannot look complete', async () => {
    renderKpis(overview(), {
      items: [],
      totals: { prospect: 0, existingCustomer: 0, unknown: 0, total: 0, existingCustomerShare: null },
      coverage: { leadsWithoutProduct: 5, leadsWithoutAccount: 7 },
    });

    await waitFor(() =>
      expect(screen.getByText(/no leads have a product attached yet/i)).toBeInTheDocument(),
    );
  });
});
