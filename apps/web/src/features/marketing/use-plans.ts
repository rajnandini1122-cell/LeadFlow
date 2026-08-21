import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { PlanView } from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';

/**
 * The plan catalogue, from the API.
 *
 * Fetched rather than bundled so there is exactly one source of pricing. The
 * alternative — a copy in the frontend — drifts the first time a price changes
 * in one place and not the other, and the version customers see is the one
 * nobody remembered to update.
 *
 * The endpoint is public, so this works with no session.
 */
export function usePlans(): UseQueryResult<PlanView[]> {
  return useQuery({
    queryKey: ['plans'],
    queryFn: () => apiGet<PlanView[]>('/plans'),
    // The catalogue changes on a deploy, not on a page view.
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/**
 * Formats a plan price.
 *
 * Uses the plan's OWN currency, never the reader's locale. What a customer is
 * charged has nothing to do with where they are browsing from, and converting a
 * published price would advertise a number nobody can actually pay.
 */
export function formatPlanPrice(amount: string, currency: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${currency} ${amount}`;
  if (value === 0) return 'Free';

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

/** Percentage saved by paying yearly, or null when there is no saving. */
export function annualSaving(plan: PlanView): number | null {
  if (plan.yearlyPrice === null) return null;

  const monthly = Number(plan.monthlyPrice);
  const yearly = Number(plan.yearlyPrice);
  if (!Number.isFinite(monthly) || !Number.isFinite(yearly) || monthly === 0) return null;

  const fullYear = monthly * 12;
  if (yearly >= fullYear) return null;

  return Math.round(((fullYear - yearly) / fullYear) * 100);
}

/** A plan's stated limit, as display copy. Never an enforcement decision. */
export function statedLimit(value: number | null, noun: string): string {
  return value === null ? `No stated ${noun} limit` : `Up to ${value.toLocaleString()} ${noun}`;
}
