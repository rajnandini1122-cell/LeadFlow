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

/** DOMESTIC = the organization's own country; INTERNATIONAL = importers abroad. */
export type LeadMarket = 'DOMESTIC' | 'INTERNATIONAL' | 'UNKNOWN';

export const MARKET_LABELS: Record<LeadMarket, string> = {
  DOMESTIC: 'India',
  INTERNATIONAL: 'International',
  UNKNOWN: 'Market unknown',
};

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
  /** ISO country code, when the enquiry or import gave one. */
  country: string | null;
  /** Home market or abroad — India vs international importers for CRAVION. */
  market: LeadMarket;
  /** The last structured call outcome (CALL_OUTCOMES code), null if none logged. */
  lastOutcome: string | null;
  lastOutcomeAt: string | null;
  /** When somebody last actually spoke to the customer. Missed calls do not move it. */
  lastContactedAt: string | null;
  latestActivity: { type: string; description: string | null; at: string } | null;
  /** The open follow-up that IS the next action. Null when nothing is queued. */
  nextAction: {
    followUpId: string;
    type: string;
    title: string | null;
    scheduledAt: string;
    assignedTo: { id: string; fullName: string };
    isOverdue: boolean;
  } | null;
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
  /** The standardised product this enquiry is for, when one is mapped. */
  product?: { id: string; name: string; sku: string; active: boolean } | null;
  /** What the customer asked for, in their words. */
  productInterest?: string | null;
  account?: { id: string; name: string; status: string } | null;
  source?: string | null;
  /** The requirement as stated on a call. */
  requirementQuantity?: string | null;
  /** YYYY-MM-DD, a calendar date. */
  expectedPurchaseDate?: string | null;
  /** How the deal closed; null while open. */
  wonAt?: string | null;
  wonValue?: string | null;
  lostAt?: string | null;
  lostReason?: string | null;
};

export interface LeadFilters {
  status?: LeadStatus | undefined;
  search?: string | undefined;
  assignedToId?: string | undefined;
  /** Only leads nobody owns — the ones no follow-up queue can show. */
  unassigned?: boolean | undefined;
  /** Still NEW and never reached. */
  fresh?: boolean | undefined;
  /** Waiting on the customer. */
  awaiting?: boolean | undefined;
  /** Last call had exactly this outcome. */
  lastOutcome?: string | undefined;
  /** Home market or abroad. */
  market?: LeadMarket | undefined;
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
  if (filters.unassigned) params['unassigned'] = 'true';
  if (filters.fresh) params['fresh'] = 'true';
  if (filters.awaiting) params['awaiting'] = 'true';
  if (filters.lastOutcome) params['lastOutcome'] = filters.lastOutcome;
  if (filters.market) params['market'] = filters.market;
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
