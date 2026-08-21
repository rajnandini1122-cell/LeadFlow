import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { LeadStatus } from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';
import type { LeadSummary } from '../leads/use-leads';

export interface DashboardSummary {
  /** Whose figures these are, so the screen can label a rep's view honestly. */
  scope: 'OWN' | 'TEAM' | 'ALL';
  timezone: string;
  followUps: { overdue: number; dueToday: number; upcoming: number };
  pipeline: {
    activeCount: number;
    activeValue: string;
    byStage: { status: LeadStatus; count: number; value: string }[];
  };
  outcomes: {
    won: number;
    lost: number;
    wonValue: string;
    conversionRate: number;
    newThisWeek: number;
  };
  contacts: number;
  nextActions: LeadSummary[];
  recent: LeadSummary[];
}

/**
 * Dashboard figures, computed by the API.
 *
 * Every number used to be derived in the browser from one page of leads, which
 * made them wrong past that page size — and wrong in the flattering direction,
 * since a truncated list always understates overdue work. Day boundaries are
 * now the organization's, not the viewer's, so a manager travelling sees the
 * same "today" as the team they manage.
 */
export function useDashboard(): UseQueryResult<DashboardSummary> {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiGet<DashboardSummary>('/dashboard'),
  });
}
