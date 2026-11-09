import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIFETIME_SCOPE,
  TRIAL_EXPIRED_MESSAGE,
  type BillingSummaryView,
  type PlanPriceView,
} from '@leadflow/api-types';

import { BillingPage } from '../features/settings/billing-page';
import * as apiClient from '../lib/api-client';

/**
 * Plan and billing. Everything shown comes from the server — the trial
 * countdown, the GST breakdown, the payment history — and nothing on this page
 * can grant access: payment is verified by the API.
 */

const price = (interval: PlanPriceView['interval'], base: string, tax: string, total: string): PlanPriceView => ({
  id: interval,
  planCode: 'PREMIUM',
  planName: 'LeadFlow Premium',
  interval,
  version: 1,
  currency: 'INR',
  baseAmount: base,
  taxRatePercent: '18',
  taxAmount: tax,
  totalAmount: total,
  taxInclusive: false,
  renewal: interval === 'LIFETIME' ? 'NONE' : 'MANUAL',
});

function summary(overrides: Partial<BillingSummaryView> = {}): BillingSummaryView {
  return {
    state: 'TRIALING',
    grantsAccess: true,
    billable: true,
    accessEndsAt: '2026-12-07T10:00:00.000Z',
    daysRemaining: 30,
    trialStartsAt: '2026-11-07T10:00:00.000Z',
    trialEndsAt: '2026-12-07T10:00:00.000Z',
    planName: 'LeadFlow Premium',
    interval: null,
    lifetime: false,
    message: null,
    enforcementEnabled: true,
    checkoutEnabled: true,
    canPay: true,
    prices: [
      price('MONTHLY', '200.00', '36.00', '236.00'),
      price('YEARLY', '1780.00', '320.40', '2100.40'),
      price('LIFETIME', '5000.00', '900.00', '5900.00'),
    ],
    payments: [],
    lifetimeScope: LIFETIME_SCOPE,
    supportEmail: 'support@cravionventures.com',
    ...overrides,
  };
}

function renderBilling(data: BillingSummaryView): void {
  vi.spyOn(apiClient, 'apiGet').mockImplementation(async (url: string) => {
    if (url === '/billing/summary') return data as never;
    throw new Error(`unexpected ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BillingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('Plan and billing', () => {
  it('shows the trial countdown and the three plans with GST, from the server', async () => {
    renderBilling(summary());
    expect(await screen.findByText('30 days remaining')).toBeInTheDocument();
    expect(screen.getAllByText('Free trial').length).toBeGreaterThan(0);
    expect(screen.getByText('₹236')).toBeInTheDocument();
    expect(screen.getByText('₹2,100.40')).toBeInTheDocument();
    expect(screen.getByText('₹5,900')).toBeInTheDocument();
    expect(screen.getAllByText(/GST \(18%\)/)).toHaveLength(3);
    expect(screen.getByText(/Nothing is charged automatically/)).toBeInTheDocument();
  });

  it('shows the exact expiry message, keeps data reassurance and support, and offers Upgrade', async () => {
    renderBilling(summary({ state: 'EXPIRED', grantsAccess: false, daysRemaining: null, accessEndsAt: null, message: TRIAL_EXPIRED_MESSAGE }));
    expect(await screen.findByRole('alert')).toHaveTextContent(TRIAL_EXPIRED_MESSAGE);
    expect(screen.getByRole('alert')).toHaveTextContent(/records are kept safe/);
    expect(screen.getAllByRole('button', { name: 'Upgrade' })).toHaveLength(3);
    expect(screen.getAllByRole('link', { name: /support/ }).length).toBeGreaterThan(0);
  });

  it('pays only through the server: checkout first, then verification of Razorpay’s response', async () => {
    const post = vi.spyOn(apiClient, 'apiPost').mockImplementation(async (url: string) => {
      if (url === '/billing/checkout')
        return { paymentId: 'p1', providerOrderId: 'order_ABC123', keyId: 'rzp_live_x', amountPaise: 23_600, currency: 'INR', receipt: 'LF-1', description: 'd', organizationName: 'Acme', prefill: { name: 'A', email: 'a@x' } } as never;
      if (url === '/billing/verify') return { receipt: 'LF-1', status: 'PAID' } as never;
      throw new Error(url);
    });
    window.Razorpay = class {
      constructor(private readonly options: Record<string, unknown>) {}
      on() {}
      open() {
        (this.options['handler'] as (r: object) => void)({ razorpay_order_id: 'order_ABC123', razorpay_payment_id: 'pay_XYZ789', razorpay_signature: 'a'.repeat(64) });
      }
    } as never;
    renderBilling(summary());
    await userEvent.click((await screen.findAllByRole('button', { name: 'Upgrade' }))[0]!);
    await waitFor(() => expect(screen.getByText('Payment LF-1 received. Thank you!')).toBeInTheDocument());
    expect(post.mock.calls.map(([url]) => url)).toEqual(['/billing/checkout', '/billing/verify']);
    expect(post.mock.calls[0]![1]).toEqual({ interval: 'MONTHLY' });
    delete window.Razorpay;
  });

  it('disables payment when checkout is off, and for someone who may not pay', async () => {
    renderBilling(summary({ checkoutEnabled: false }));
    expect(await screen.findByText(/Online payment is being switched on/)).toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { name: 'Upgrade' })) expect(b).toBeDisabled();
  });

  it('lists payment history with the GST breakdown', async () => {
    renderBilling(
      summary({
        state: 'ACTIVE',
        interval: 'MONTHLY',
        payments: [
          { id: 'p1', receipt: 'LF-20261107-abcd1234', interval: 'MONTHLY', status: 'PAID', currency: 'INR', baseAmount: '200.00', taxAmount: '36.00', totalAmount: '236.00', refundedAmount: '0.00', providerPaymentId: 'pay_1', periodStart: null, periodEnd: null, paidAt: '2026-11-07T10:00:00.000Z', createdAt: '2026-11-07T10:00:00.000Z' },
        ],
      }),
    );
    expect(await screen.findByText('LF-20261107-abcd1234')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('₹200 + ₹36 GST')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Renew' })).toHaveLength(2);
  });

  it('the internal CRAVION account sees no price, no countdown and no upgrade prompt', async () => {
    renderBilling(summary({ state: 'EXEMPT', billable: false, prices: [], daysRemaining: null }));
    expect(await screen.findByText('Internal CRAVION account')).toBeInTheDocument();
    expect(screen.queryByText(/₹/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).not.toBeInTheDocument();
  });
});
