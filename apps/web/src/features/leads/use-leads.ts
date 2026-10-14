import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type InfiniteData,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  LeadLifecycleFilter,
  LeadPriority,
  LeadStatus,
  Paginated,
} from '@leadflow/api-types';
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
  /** Null for a live lead. On the summary so the inactive list can show it. */
  deactivatedAt: string | null;
}

export interface LeadActivity {
  id: string;
  type: string;
  description: string | null;
  performedBy: { id: string; fullName: string } | null;
  createdAt: string;
}

export type LeadDetail = LeadSummary & {
  activities: LeadActivity[];
  email: string | null;
  /**
   * The whole postal address.
   *
   * `city` was the only one of these that existed before this release, which is
   * why a CSV address column had nowhere to go and was dropped.
   */
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  /** Why this record is not live work, and who decided. Null when it is. */
  deactivationReason: string | null;
  deactivatedBy: string | null;
  /** The import run that created it, or null if a person typed it in. */
  importBatchId: string | null;
};

export interface LeadFilters {
  status?: LeadStatus | undefined;
  search?: string | undefined;
  assignedToId?: string | undefined;
  /** Every lead from one CSV import, for correcting a bad run. */
  importBatchId?: string | undefined;
  /** Omitted means ACTIVE, which is what keeps deactivated leads out. */
  lifecycle?: LeadLifecycleFilter | undefined;
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
  if (filters.importBatchId) params['importBatchId'] = filters.importBatchId;
  if (filters.lifecycle) params['lifecycle'] = filters.lifecycle;

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
