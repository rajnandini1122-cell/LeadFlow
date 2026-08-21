import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type InfiniteData,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { LeadPriority, LeadStatus, Paginated } from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';

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
 * One lead, with its activity timeline.
 *
 * There is deliberately no "fetch every lead and count them in the browser"
 * helper any more. Aggregate figures come from /dashboard and /reports, which
 * count the whole tenant dataset in the database and bucket dates in the
 * organization's timezone — a page of leads could only ever describe itself.
 */
export function useLead(id: string | undefined): UseQueryResult<LeadDetail> {
  return useQuery({
    queryKey: ['lead', id],
    queryFn: () => apiGet<LeadDetail>(`/leads/${id as string}`),
    enabled: Boolean(id),
  });
}
