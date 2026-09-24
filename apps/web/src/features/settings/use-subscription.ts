import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  BillingInterval,
  EntitlementView,
  PlanView,
  SubscriptionStatus,
  SubscriptionView,
} from '@leadflow/api-types';
import { apiGet, apiPatch } from '../../lib/api-client';

export function useSubscription(): UseQueryResult<SubscriptionView> {
  return useQuery({
    queryKey: ['subscription'],
    queryFn: () => apiGet<SubscriptionView>('/subscriptions/current'),
  });
}

/**
 * What this organization is entitled to, and whether to mention money at all.
 *
 * Read INSTEAD of `useSubscription` when deciding what billing UI to show. The
 * CRAVION platform organization has no subscription row — `/subscriptions/current`
 * is a 404 there and should be — so a screen that asked for the subscription
 * first would show an error to the operator on every visit.
 */
export function useEntitlement(): UseQueryResult<EntitlementView> {
  return useQuery({
    queryKey: ['entitlement'],
    queryFn: () => apiGet<EntitlementView>('/subscriptions/entitlement'),
  });
}

export function usePlanCatalogue(): UseQueryResult<PlanView[]> {
  return useQuery({
    queryKey: ['plans'],
    queryFn: () => apiGet<PlanView[]>('/plans'),
    staleTime: 5 * 60_000,
  });
}

/**
 * Changes plan or billing interval.
 *
 * Deliberately cannot send `status`. Declaring yourself ACTIVE would be
 * declaring that you have paid, which only a payment provider can know — the
 * API rejects the field outright rather than ignoring it.
 */
export function useChangePlan(): UseMutationResult<
  SubscriptionView,
  Error,
  { planCode?: string; billingInterval?: BillingInterval }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: { planCode?: string; billingInterval?: BillingInterval }) =>
      apiPatch<SubscriptionView>('/subscriptions/current', body),
    onSuccess: (updated) => {
      queryClient.setQueryData(['subscription'], updated);
      // The change is recorded, so the administrative history is now stale.
      void queryClient.invalidateQueries({ queryKey: ['audit-trail'] });
    },
  });
}

/** How a status should read and look. */
export const STATUS_PRESENTATION: Record<
  SubscriptionStatus,
  { label: string; tone: 'good' | 'warn' | 'bad'; meaning: string }
> = {
  TRIAL: {
    label: 'Trial',
    tone: 'good',
    meaning: 'You are evaluating LeadFlow. No payment has been taken.',
  },
  ACTIVE: { label: 'Active', tone: 'good', meaning: 'Your subscription is current.' },
  PAST_DUE: {
    label: 'Payment due',
    tone: 'warn',
    // Access continues on purpose: cutting someone off on the first failed
    // charge loses accounts that a retry would have recovered.
    meaning: 'A payment did not go through. Your account still works while we retry.',
  },
  CANCELLED: {
    label: 'Cancelled',
    tone: 'bad',
    meaning: 'This subscription has been cancelled.',
  },
  EXPIRED: { label: 'Expired', tone: 'bad', meaning: 'This subscription has ended.' },
};

/** Whole days from now until an instant, floored at zero. */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;

  const remaining = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(remaining / 86_400_000));
}
