import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { LeadPriority, LeadStatus, Paginated } from '@idea001/api-types';
import { apiGet } from '../../lib/api-client';
import { daysUntil } from '../../lib/format';

export interface LeadSummary {
  id: string;
  leadNumber: string;
  name: string;
  companyName: string | null;
  mobile: string | null;
  status: LeadStatus;
  priority: LeadPriority;
  estimatedValue: string | null;
  nextFollowUpAt: string | null;
  assignedTo: { id: string; fullName: string } | null;
  createdAt: string;
}

export interface LeadActivity {
  id: string;
  type: string;
  description: string | null;
  performedBy: { id: string; fullName: string } | null;
  createdAt: string;
}

export type LeadDetail = LeadSummary & { activities: LeadActivity[] };

/**
 * The lead list.
 *
 * Phase 1 exposes leads read-only, and there is no aggregation endpoint yet, so
 * every screen works from one page of leads and derives its own counts. That is
 * honest for a dataset this size but does not scale — the dashboard and reports
 * APIs in Phase 4 replace this with server-side aggregation.
 */
export function useLeads(params?: {
  status?: LeadStatus;
  search?: string;
  limit?: number;
}): UseQueryResult<Paginated<LeadSummary>> {
  const query: Record<string, unknown> = { limit: params?.limit ?? 100 };
  if (params?.status) query['status'] = params.status;
  if (params?.search) query['search'] = params.search;

  return useQuery({
    queryKey: ['leads', query],
    queryFn: () => apiGet<Paginated<LeadSummary>>('/leads', query),
  });
}

export function useLead(id: string | undefined): UseQueryResult<LeadDetail> {
  return useQuery({
    queryKey: ['lead', id],
    queryFn: () => apiGet<LeadDetail>(`/leads/${id as string}`),
    enabled: Boolean(id),
  });
}

export const TERMINAL: LeadStatus[] = ['WON', 'LOST'];

export const isActive = (lead: LeadSummary): boolean => !TERMINAL.includes(lead.status);

/**
 * Buckets used by the dashboard and the follow-up screen.
 *
 * Terminal leads are excluded everywhere: a WON deal has no next action, and
 * counting it as "missing a follow-up" would be noise.
 */
export function bucketLeads(leads: LeadSummary[]) {
  const active = leads.filter(isActive);

  const overdue = active.filter((lead) => {
    const days = daysUntil(lead.nextFollowUpAt);
    return days !== null && days < 0;
  });

  const today = active.filter((lead) => daysUntil(lead.nextFollowUpAt) === 0);

  const upcoming = active.filter((lead) => {
    const days = daysUntil(lead.nextFollowUpAt);
    return days !== null && days > 0;
  });

  const sumValue = (rows: LeadSummary[]): number =>
    rows.reduce((total, lead) => total + Number(lead.estimatedValue ?? 0), 0);

  const won = leads.filter((lead) => lead.status === 'WON');
  const lost = leads.filter((lead) => lead.status === 'LOST');
  const decided = won.length + lost.length;

  return {
    all: leads,
    active,
    overdue: overdue.sort(byDueDate),
    today: today.sort(byDueDate),
    upcoming: upcoming.sort(byDueDate),
    won,
    lost,
    pipelineValue: sumValue(active),
    wonValue: sumValue(won),
    /** Won as a share of decided deals — open leads are not yet a loss. */
    conversionRate: decided === 0 ? 0 : Math.round((won.length / decided) * 100),
    newThisWeek: leads.filter(
      (lead) => Date.now() - new Date(lead.createdAt).getTime() < 7 * 86_400_000,
    ).length,
  };
}

function byDueDate(a: LeadSummary, b: LeadSummary): number {
  return (a.nextFollowUpAt ?? '').localeCompare(b.nextFollowUpAt ?? '');
}
