import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { LeadStatus, RoleKey } from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';

export const RANGE_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'custom',
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number];

export const PRESET_LABELS: Record<RangePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom',
};

export interface RangeSelection {
  preset: RangePreset;
  from?: string;
  to?: string;
}

export interface ReportRange {
  preset: RangePreset;
  /** Absolute instants — the actual query bounds. */
  from: string;
  to: string;
  /** Wall-clock days in the organization timezone. `toDate` is inclusive. */
  fromDate: string;
  toDate: string;
  timezone: string;
}

export type ReportScope = 'OWN' | 'TEAM' | 'ALL';

export interface ReportOverview {
  range: ReportRange;
  scope: ReportScope;
  /** Which timestamp each metric is measured against, straight from the API. */
  basis: Record<string, string>;
  snapshot: {
    totalLeads: number;
    activeLeads: number;
    pipelineValue: string;
  };
  leads: {
    created: number;
    won: number;
    lost: number;
    archived: number;
    wonValue: string;
    conversionRate: number;
    byStatus: { status: LeadStatus; count: number; value: string }[];
    bySource: { source: string; count: number }[];
    lostReasons: { reason: string; count: number }[];
  };
  followUps: {
    dueToday: number;
    overdue: number;
    completed: number;
    scheduled: number;
    completionRate: number;
  };
}

export interface DailyReport {
  date: string;
  timezone: string;
  scope: ReportScope;
  leadsCreated: number;
  leadsContacted: number;
  callsCompleted: number;
  callsNotAnswered: number;
  whatsappActivities: number;
  notesAdded: number;
  followUpsCompleted: number;
  followUpsOverdue: number;
  leadsWon: number;
  leadsLost: number;
  wonValueToday: string;
}

export interface TeamMemberPerformance {
  userId: string;
  fullName: string;
  email: string;
  role: RoleKey;
  status: string;
  leadsAssigned: number;
  leadsCreated: number;
  activeLeads: number;
  wonLeads: number;
  lostLeads: number;
  wonValue: string;
  pipelineValue: string;
  conversionRate: number;
  openFollowUps: number;
  overdueFollowUps: number;
  completedFollowUps: number;
  followUpCompletionRate: number;
  lastActivityAt: string | null;
  activityCount: number;
}

export interface TeamReport {
  range: ReportRange;
  scope: ReportScope;
  members: TeamMemberPerformance[];
}

/**
 * Turns a selection into query parameters.
 *
 * A custom range is only sent once both ends are filled in; a half-finished
 * date pair would otherwise fire a request the API correctly rejects, and the
 * user would watch an error flash while they were still typing.
 */
function rangeParams(selection: RangeSelection): Record<string, string> | null {
  if (selection.preset !== 'custom') return { preset: selection.preset };
  if (!selection.from || !selection.to) return null;
  return { preset: 'custom', from: selection.from, to: selection.to };
}

/**
 * Headline metrics for a date range.
 *
 * Aggregated by the API over the whole tenant dataset. These figures used to be
 * derived in the browser from one page of leads, which made them silently wrong
 * past that page size — and wrong in the flattering direction, because a
 * truncated list always understates overdue work.
 */
export function useReportOverview(
  selection: RangeSelection,
): UseQueryResult<ReportOverview> {
  const params = rangeParams(selection);

  return useQuery({
    queryKey: ['report-overview', params],
    queryFn: () => apiGet<ReportOverview>('/reports/overview', params ?? {}),
    enabled: params !== null,
  });
}

/** One day of activity, bucketed in the organization's timezone. */
export function useDailyReport(date?: string): UseQueryResult<DailyReport> {
  return useQuery({
    queryKey: ['report-daily', date ?? 'today'],
    queryFn: () => apiGet<DailyReport>('/reports/daily', date ? { date } : {}),
  });
}

/** Per-member performance. Requires report.view; the API enforces it. */
export function useTeamReport(
  selection: RangeSelection,
  enabled = true,
): UseQueryResult<TeamReport> {
  const params = rangeParams(selection);

  return useQuery({
    queryKey: ['report-team', params],
    queryFn: () => apiGet<TeamReport>('/reports/team', params ?? {}),
    enabled: enabled && params !== null,
  });
}

/** What the API scope means, in words a user can act on. */
export function scopeLabel(scope: ReportScope): string {
  return scope === 'OWN' ? 'Your leads only' : 'Whole organization';
}
