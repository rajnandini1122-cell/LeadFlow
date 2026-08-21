import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type InfiniteData,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { LeadPriority, LeadStatus, Paginated } from '@leadflow/api-types';
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

export interface LeadFilters {
  status?: LeadStatus | undefined;
  search?: string | undefined;
  assignedToId?: string | undefined;
}

/**
 * One page of leads, followed by the next on demand.
 *
 * The list screen used to load a flat first-100 and filter in the browser,
 * which meant an organization past its hundredth lead was quietly looking at a
 * truncated pipeline — and the numbers above the list described the page, not
 * the data. Filtering, sorting and counting all happen server-side now; this
 * hook only stitches the pages together.
 */
export function useLeadsPage(
  filters: LeadFilters,
  limit = 25,
): UseInfiniteQueryResult<InfiniteData<Paginated<LeadSummary>>> {
  const params: Record<string, unknown> = { limit };
  if (filters.status) params['status'] = filters.status;
  if (filters.search) params['search'] = filters.search;
  if (filters.assignedToId) params['assignedToId'] = filters.assignedToId;

  return useInfiniteQuery({
    queryKey: ['leads', 'page', params],
    queryFn: ({ pageParam }) =>
      apiGet<Paginated<LeadSummary>>('/leads', {
        ...params,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * A flat page of leads, used by the screens that still aggregate in the
 * browser (reports, the team roster).
 *
 * Those screens are honest about the limit in their own copy. New aggregate
 * figures belong on the dashboard API, which counts the whole dataset.
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
