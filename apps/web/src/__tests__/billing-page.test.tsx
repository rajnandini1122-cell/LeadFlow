import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanView, SubscriptionView } from '@leadflow/api-types';

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
    code: 'PROFESSIONAL',
    name: 'Professional',
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
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) =>
      Promise.resolve((url === '/plans' ? PLANS : subscription()) as never),
    );
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

    await user.click(await screen.findByRole('button', { name: /switch to professional/i }));
    // Nothing has been sent yet.
    expect(apiClient.apiPatch).not.toHaveBeenCalled();

    const confirm = await screen.findByRole('alert');
    await user.click(within(confirm).getByRole('button', { name: /yes, change plan/i }));

    await waitFor(() => {
      expect(apiClient.apiPatch).toHaveBeenCalledWith('/subscriptions/current', {
        planCode: 'PROFESSIONAL',
      });
    });
  });

  it('NEVER sends a status when changing plan', async () => {
    const user = userEvent.setup();
    vi.spyOn(apiClient, 'apiPatch').mockResolvedValue(subscription() as never);

    renderBilling();

    await user.click(await screen.findByRole('button', { name: /switch to professional/i }));
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
    vi.spyOn(apiClient, 'apiGet').mockImplementation((url: string) =>
      Promise.resolve(
        (url === '/plans' ? PLANS : subscription({ status: 'PAST_DUE' })) as never,
      ),
    );

    renderBilling();

    expect(await screen.findByText('Payment due')).toBeInTheDocument();
    // Access continues on purpose — cutting someone off on the first failed
    // charge loses accounts a retry would have recovered.
    expect(screen.getByText(/still works while we retry/i)).toBeInTheDocument();
  });

  it('reports a missing subscription as the fault it is', async () => {
    vi.spyOn(apiClient, 'apiGet').mockRejectedValue(
      new apiClient.ApiError('SUBSCRIPTION_NOT_FOUND', 'none', 404),
    );

    renderBilling();

    expect(await screen.findByText(/should not happen/i)).toBeInTheDocument();
  });
});
