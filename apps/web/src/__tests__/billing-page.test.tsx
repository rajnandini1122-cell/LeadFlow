import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementView, PlanView, SubscriptionView } from '@leadflow/api-types';

import { BillingPage } from '../features/settings/billing-page';
import * as apiClient from '../lib/api-client';
import * as authContext from '../features/auth/auth-context';

/**
 * Plan and billing.
 *
 * The assertions that matter are the honest ones. No payment provider is
 * integrated and plan limits are not enforced, so the screen has to say both —
 * an owner who believes a card is on file, or that a stated limit will hold,
 * has been misled by the software rather than by anyone in particular.
 */

const PLANS: PlanView[] = [
  {
    id: '1',
    code: 'STARTER',
    name: 'Starter',
    tagline: 'For a founder',
    description: null,
    featured: false,
    currency: 'USD',
    monthlyPrice: '0',
    yearlyPrice: '0',
    maxUsers: 3,
    maxActiveLeads: 500,
    features: ['Up to 3 team members'],
  },
  {
    id: '2',
    code: 'BASIC',
    name: 'Basic',
    tagline: 'For a sales team',
    description: null,
    featured: true,
    currency: 'USD',
    monthlyPrice: '29',
    yearlyPrice: '290',
    maxUsers: 15,
    maxActiveLeads: 10_000,
    features: ['Up to 15 team members', 'Team performance reporting'],
  },
];

function subscription(overrides: Partial<SubscriptionView> = {}): SubscriptionView {
  return {
    id: 'sub-1',
    status: 'TRIAL',
    billingInterval: 'MONTHLY',
    currentPeriodStart: '2026-08-01T00:00:00.000Z',
    currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    trialEndsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    cancelledAt: null,
    plan: PLANS[0] as PlanView,
    grantsAccess: true,
    limitsEnforced: false,
    ...overrides,
  };
}

/**
 * A customer's entitlement.
 *
 * The page reads this BEFORE the subscription, to decide whether the screen is
 * about money at all. Every existing assertion below depends on `billable`
 * being true — without it the page correctly renders CRAVION's internal card
 * instead, which is the behaviour the new tests at the bottom cover.
 */
function entitlement(overrides: Partial<EntitlementView> = {}): EntitlementView {
  return {
    source: 'CUSTOMER_SUBSCRIPTION',
    grantsAccess: true,
    billable: true,
    maxUsers: 5,
    maxActiveLeads: 500,
    limitsEnforced: false,
    subscription: subscription(),
    ...overrides,
  };
}

function mockAuth(permissions: string[]): void {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    can: (permission: string) => permissions.includes(permission),
  } as never);
}

function renderBilling(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BillingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Plan and billing', () => {
  beforeEach(() => {
    mockAuth(['subscription.view', 'subscription.manage']);
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
      if (url === '/plans') return Promise.resolve(PLANS as never);
      if (url === '/subscriptions/entitlement') return Promise.resolve(entitlement() as never);
      return Promise.resolve(subscription() as never);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the current plan and status', async () => {
    renderBilling();

    expect(await screen.findByText('Starter')).toBeInTheDocument();
    expect(screen.getByText('Trial')).toBeInTheDocument();
  });

  it('counts down the trial from the real period end', async () => {
    renderBilling();
    expect(await screen.findByText(/5 days left in your trial/i)).toBeInTheDocument();
  });

  it('says plainly that no payment is set up', async () => {
    renderBilling();

    // An owner who believes a card is on file has been misled by the software.
    expect(await screen.findByText(/no payment set up/i)).toBeInTheDocument();
    expect(screen.getByText(/no card on file/i)).toBeInTheDocument();
  });

  it('says the stated limits are not applied', async () => {
    renderBilling();

    expect(await screen.findByText(/limits are not currently applied/i)).toBeInTheDocument();
    // The numbers are still shown — they describe the tier, they just do not
    // constrain the account.
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('changes plan only after an explicit confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(
      subscription({ plan: PLANS[1] as PlanView }) as never,
    );

    renderBilling();

    await user.click(await screen.findByRole('button', { name: /switch to basic/i }));
    // Nothing has been sent yet.
    expect(apiClient.apiPatch).not.toHaveBeenCalled();

    const confirm = await screen.findByRole('alert');
    await user.click(within(confirm).getByRole('button', { name: /yes, change plan/i }));

    await waitFor(() => {
      expect(apiClient.apiPatch).toHaveBeenCalledWith('/subscriptions/current', {
        planCode: 'BASIC',
      });
    });
  });

  it('NEVER sends a status when changing plan', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(subscription() as never);

    renderBilling();

    await user.click(await screen.findByRole('button', { name: /switch to basic/i }));
    const confirm = await screen.findByRole('alert');
    await user.click(within(confirm).getByRole('button', { name: /yes, change plan/i }));

    await waitFor(() => {
      const body = vi.mocked(apiClient.apiPatch).mock.calls[0]?.[1] as Record<string, unknown>;
      // Declaring yourself ACTIVE is declaring that you have paid. Only a
      // payment provider can know that.
      expect(body).not.toHaveProperty('status');
    });
  });

  it('switches billing interval', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(
      subscription({ billingInterval: 'YEARLY' }) as never,
    );

    renderBilling();
    await user.click(await screen.findByRole('radio', { name: 'Yearly' }));

    await waitFor(() => {
      expect(apiClient.apiPatch).toHaveBeenCalledWith('/subscriptions/current', {
        billingInterval: 'YEARLY',
      });
    });
  });

  it('hides plan changes from someone who may only view', async () => {
    mockAuth(['subscription.view']);
    renderBilling();

    expect(await screen.findByText('Starter')).toBeInTheDocument();
    // The API enforces this too; hiding it just avoids offering an action that
    // would certainly fail.
    expect(screen.queryByRole('heading', { name: 'Change plan' })).toBeNull();
  });

  it('explains a past-due account without alarming the user', async () => {
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
      if (url === '/plans') return Promise.resolve(PLANS as never);
      if (url === '/subscriptions/entitlement') return Promise.resolve(entitlement() as never);
      return Promise.resolve(subscription({ status: 'PAST_DUE' }) as never);
    });

    renderBilling();

    expect(await screen.findByText('Payment due')).toBeInTheDocument();
    // Access continues on purpose — cutting someone off on the first failed
    // charge loses accounts a retry would have recovered.
    expect(screen.getByText(/still works while we retry/i)).toBeInTheDocument();
  });

  it('reports a missing subscription as the fault it is', async () => {
    // A BILLABLE organization with no subscription row really is a fault. The
    // platform organization is a different case entirely — it is not billable,
    // and never reaches this branch.
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
      if (url === '/subscriptions/entitlement') return Promise.resolve(entitlement() as never);
      return Promise.reject(new apiClient.ApiError('SUBSCRIPTION_NOT_FOUND', 'none', 404));
    });

    renderBilling();

    expect(await screen.findByText(/should not happen/i)).toBeInTheDocument();
  });

  /**
   * CRAVION's own organization.
   *
   * The platform operator has no plan, no period and no payment. The screen has
   * to say that without claiming the account is "paid", which would be a
   * different false statement from the one it replaces.
   */
  describe('the internal CRAVION account', () => {
    beforeEach(() => {
      vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) => {
        if (url === '/plans') return Promise.resolve(PLANS as never);
        if (url === '/subscriptions/entitlement') {
          return Promise.resolve(
            entitlement({
              source: 'PLATFORM_INTERNAL',
              billable: false,
              maxUsers: null,
              maxActiveLeads: null,
              subscription: null,
            }) as never,
          );
        }

        // The platform organization has no subscription row, and asking for one
        // is a 404. A screen that read this first would show an error on every
        // visit — which is why the entitlement is read first.
        return Promise.reject(new apiClient.ApiError('SUBSCRIPTION_NOT_FOUND', 'none', 404));
      });
    });

    it('identifies the account as the platform owner', async () => {
      renderBilling();

      expect(await screen.findByText('Internal CRAVION account')).toBeInTheDocument();
      expect(screen.getByText('Platform Owner')).toBeInTheDocument();
    });

    it('shows no trial countdown, no price and no upgrade prompt', async () => {
      renderBilling();

      await screen.findByText('Internal CRAVION account');

      expect(screen.queryByText(/days left/i)).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Change plan' })).toBeNull();
      expect(screen.queryByText(/upgrade/i)).toBeNull();
      expect(screen.queryByText(/₹/)).toBeNull();
    });

    it('does not claim the account is paid', async () => {
      renderBilling();

      await screen.findByText('Internal CRAVION account');

      // "No bill" is not "bill settled". Implying payment would be a new
      // falsehood rather than the removal of one.
      expect(screen.queryByText(/paid/i)).toBeNull();
      expect(screen.queryByText(/active subscription/i)).toBeNull();
    });

    it('shows no subscription error, even though there is no subscription', async () => {
      renderBilling();

      await screen.findByText('Internal CRAVION account');

      expect(screen.queryByText(/should not happen/i)).toBeNull();
      expect(screen.queryByText(/Could not load/i)).toBeNull();
    });
  });
});
