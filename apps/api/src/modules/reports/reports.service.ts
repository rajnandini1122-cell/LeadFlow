import { Injectable } from '@nestjs/common';
import type { LeadStatus, RoleKey } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { decimalString, percentage, wonRevenue } from '../../common/utils/decimal';
import {
  addZonedDays,
  formatZonedDate,
  parseZonedDate,
  startOfZonedDay,
  zonedDate,
} from '../../common/utils/zoned-time';
import type { ActivityType } from '../../generated/prisma/enums';
import { LeadsRepository } from '../leads/leads.repository';
import { resolveLeadVisibility, visibilityFilter } from '../leads/lead-visibility';
import {
  DateRangeError,
  METRIC_BASIS,
  resolveDateRange,
  type DateRange,
  type RangePreset,
} from './date-range';
import { OPEN_FOLLOW_UP_STATUSES, ReportsRepository } from './reports.repository';

// -----------------------------------------------------------------------------
// Response shapes
// -----------------------------------------------------------------------------

export interface ReportRange {
  preset: RangePreset;
  from: string;
  to: string;
  fromDate: string;
  toDate: string;
  timezone: string;
}

export interface ReportOverview {
  range: ReportRange;
  /** Whose figures these are, so a rep's view is never mistaken for the team's. */
  scope: 'OWN' | 'TEAM' | 'ALL';
  /** Which timestamp each metric is measured against. */
  basis: typeof METRIC_BASIS;
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
  scope: 'OWN' | 'TEAM' | 'ALL';
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
  scope: 'OWN' | 'TEAM' | 'ALL';
  members: TeamMemberPerformance[];
}

/** Activity types that mean a human actually reached out to the customer. */
const CONTACT_ACTIVITIES: ActivityType[] = [
  'CALL_COMPLETED',
  'CALL_NOT_ANSWERED',
  'CALL_BACK_LATER',
  'WHATSAPP_SENT',
  'WHATSAPP_OPENED',
];

const WHATSAPP_ACTIVITIES: ActivityType[] = [
  'WHATSAPP_SENT',
  'WHATSAPP_OPENED',
  'WHATSAPP_DELIVERED',
  'WHATSAPP_READ',
  'WHATSAPP_RECEIVED',
];

@Injectable()
export class ReportsService {
  constructor(
    private readonly repository: ReportsRepository,
    private readonly leads: LeadsRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------

  /**
   * Every headline figure in one request.
   *
   * Issued as one batch of aggregate queries rather than a sequence: the screen
   * is useless until all of it has arrived, so staggering the requests only
   * produces a longer series of layout jumps.
   */
  async overview(
    query: { preset?: string | undefined; from?: string | undefined; to?: string | undefined },
    principal: TenantPrincipal,
  ): Promise<ReportOverview> {
    const timezone = await this.leads.organizationTimezone();
    const range = this.resolve(query, timezone);
    const restrictToUserId = visibilityFilter(principal)?.assignedToId;
    const now = new Date();

    const todayStart = startOfZonedDay(zonedDate(now, timezone), timezone);
    const tomorrowStart = startOfZonedDay(
      addZonedDays(zonedDate(now, timezone), 1),
      timezone,
    );

    const [
      snapshot,
      created,
      byStatus,
      bySource,
      won,
      lost,
      lostReasons,
      archived,
      overdue,
      dueToday,
      completed,
      scheduledByStatus,
    ] = await Promise.all([
      this.repository.snapshot(restrictToUserId),
      this.repository.createdInRange(range.from, range.to, restrictToUserId),
      this.repository.createdByStatus(range.from, range.to, restrictToUserId),
      this.repository.createdBySource(range.from, range.to, restrictToUserId),
      this.repository.wonInRange(range.from, range.to, restrictToUserId),
      this.repository.lostInRange(range.from, range.to, restrictToUserId),
      this.repository.lostReasons(range.from, range.to, restrictToUserId),
      this.repository.archivedInRange(range.from, range.to, restrictToUserId),
      this.repository.overdueFollowUps(now, restrictToUserId),
      this.repository.openFollowUpsBetween(todayStart, tomorrowStart, restrictToUserId),
      this.repository.completedFollowUps(range.from, range.to, restrictToUserId),
      this.repository.scheduledByStatus(range.from, range.to, restrictToUserId),
    ]);

    const wonCount = won._count._all;
    const scheduledTotal = scheduledByStatus.reduce((sum, row) => sum + row._count._all, 0);
    const scheduledCompleted =
      scheduledByStatus.find((row) => row.status === 'COMPLETED')?._count._all ?? 0;

    return {
      range: toReportRange(range),
      scope: resolveLeadVisibility(principal),
      basis: METRIC_BASIS,
      snapshot: {
        totalLeads: snapshot.totalLeads,
        activeLeads: snapshot.activeLeads,
        pipelineValue: decimalString(snapshot.pipelineValue),
      },
      leads: {
        created,
        won: wonCount,
        lost,
        archived,
        wonValue: wonRevenue(won._sum.wonValue, won._sum.estimatedValue),
        // Open leads are not yet a loss, so only decided deals count. Dividing
        // by every lead would make a healthy pipeline look like a failing one.
        conversionRate: percentage(wonCount, wonCount + lost),
        byStatus: byStatus.map((row) => ({
          status: row.status as LeadStatus,
          count: row._count._all,
          value: decimalString(row._sum.estimatedValue),
        })),
        bySource: bySource.map((row) => ({
          source: row.source ?? 'Unspecified',
          count: row._count._all,
        })),
        lostReasons: lostReasons.map((row) => ({
          reason: row.lostReason as string,
          count: row._count._all,
        })),
      },
      followUps: {
        dueToday,
        overdue,
        completed,
        scheduled: scheduledTotal,
        // Numerator and denominator come from ONE grouped query over the same
        // rows, so the rate cannot exceed 100% the way two independent counts
        // over slightly different filters eventually would.
        completionRate: percentage(scheduledCompleted, scheduledTotal),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Daily report
  // ---------------------------------------------------------------------------

  /**
   * One day's activity, bucketed in the organization's timezone.
   *
   * "Today" is a wall-clock day for the team, not for the server and not for
   * whoever is looking at the screen.
   */
  async daily(
    query: { date?: string | undefined },
    principal: TenantPrincipal,
  ): Promise<DailyReport> {
    const timezone = await this.leads.organizationTimezone();
    const now = new Date();

    const day = query.date ? parseZonedDate(query.date) : zonedDate(now, timezone);
    if (!day) {
      throw AppException.validation('Invalid date.', {
        date: ['must be a real calendar date in YYYY-MM-DD form'],
      });
    }

    const from = startOfZonedDay(day, timezone);
    const to = startOfZonedDay(addZonedDays(day, 1), timezone);
    const restrictToUserId = visibilityFilter(principal)?.assignedToId;

    const [created, byType, contacted, completedFollowUps, overdue, won, lost] =
      await Promise.all([
        this.repository.createdInRange(from, to, restrictToUserId),
        this.repository.activitiesByType(from, to, restrictToUserId),
        this.repository.leadsTouched(from, to, CONTACT_ACTIVITIES, restrictToUserId),
        this.repository.completedFollowUps(from, to, restrictToUserId),
        this.repository.overdueFollowUps(now, restrictToUserId),
        this.repository.wonInRange(from, to, restrictToUserId),
        this.repository.lostInRange(from, to, restrictToUserId),
      ]);

    const countOf = (types: ActivityType[]): number =>
      byType
        .filter((row) => types.includes(row.activityType))
        .reduce((sum, row) => sum + row._count._all, 0);

    return {
      date: formatZonedDate(day),
      timezone,
      scope: resolveLeadVisibility(principal),
      leadsCreated: created,
      leadsContacted: contacted,
      callsCompleted: countOf(['CALL_COMPLETED']),
      callsNotAnswered: countOf(['CALL_NOT_ANSWERED']),
      whatsappActivities: countOf(WHATSAPP_ACTIVITIES),
      notesAdded: countOf(['NOTE_ADDED']),
      followUpsCompleted: completedFollowUps,
      // A snapshot: what is late right now, which is the number that drives
      // the morning huddle. Scoping it to the chosen day would report zero on
      // every day but today.
      followUpsOverdue: overdue,
      leadsWon: won._count._all,
      leadsLost: lost,
      wonValueToday: wonRevenue(won._sum.wonValue, won._sum.estimatedValue),
    };
  }

  // ---------------------------------------------------------------------------
  // Team performance
  // ---------------------------------------------------------------------------

  /**
   * Per-member figures, assembled from a fixed number of grouped queries.
   *
   * Nine queries regardless of team size. The obvious implementation — loop the
   * members, count each one's leads — is nine queries per person, which is fine
   * for the four-person team you test with and unusable for the fortieth.
   */
  async team(
    query: { preset?: string | undefined; from?: string | undefined; to?: string | undefined },
    principal: TenantPrincipal,
  ): Promise<TeamReport> {
    const timezone = await this.leads.organizationTimezone();
    const range = this.resolve(query, timezone);
    const visibility = resolveLeadVisibility(principal);
    const now = new Date();

    const [
      members,
      active,
      assigned,
      createdBy,
      wonBy,
      lostBy,
      openFollowUps,
      overdueFollowUps,
      completedFollowUps,
      scheduledFollowUps,
      lastActivity,
    ] = await Promise.all([
      this.repository.members(),
      this.repository.activeByAssignee(),
      this.repository.assignedInRange(range.from, range.to),
      this.repository.createdByUserInRange(range.from, range.to),
      this.repository.closedByAssignee(range.from, range.to, 'won'),
      this.repository.closedByAssignee(range.from, range.to, 'lost'),
      this.repository.followUpsByAssignee({ statuses: OPEN_FOLLOW_UP_STATUSES }),
      this.repository.followUpsByAssignee({
        statuses: OPEN_FOLLOW_UP_STATUSES,
        scheduledBefore: now,
      }),
      this.repository.followUpsByAssignee({
        from: range.from,
        to: range.to,
        completed: true,
      }),
      this.repository.followUpsByAssignee({ from: range.from, to: range.to }),
      this.repository.lastActivityByUser(range.from, range.to),
    ]);

    const index = <T extends { _count: { _all: number } }>(
      rows: T[],
      key: (row: T) => string | null,
    ): Map<string, T> => {
      const map = new Map<string, T>();
      for (const row of rows) {
        const id = key(row);
        if (id) map.set(id, row);
      }
      return map;
    };

    const activeBy = index(active, (row) => row.assignedToId);
    const assignedBy = index(assigned, (row) => row.assignedToId);
    const authoredBy = index(createdBy, (row) => row.createdBy);
    const wonMap = index(wonBy, (row) => row.assignedToId);
    const lostMap = index(lostBy, (row) => row.assignedToId);
    const openMap = index(openFollowUps, (row) => row.assignedUserId);
    const overdueMap = index(overdueFollowUps, (row) => row.assignedUserId);
    const completedMap = index(completedFollowUps, (row) => row.assignedUserId);
    const scheduledMap = index(scheduledFollowUps, (row) => row.assignedUserId);
    const activityMap = index(lastActivity, (row) => row.performedById);

    // A caller who can see only their own leads sees only their own row, even
    // though holding report.view got them this far. Two checks, not one.
    const visible =
      visibility === 'OWN'
        ? members.filter((member) => member.userId === principal.userId)
        : members;

    const rows: TeamMemberPerformance[] = visible.map((member) => {
      const id = member.userId;
      const wonCount = wonMap.get(id)?._count._all ?? 0;
      const lostCount = lostMap.get(id)?._count._all ?? 0;
      const completed = completedMap.get(id)?._count._all ?? 0;
      const scheduled = scheduledMap.get(id)?._count._all ?? 0;
      const wonRow = wonMap.get(id);

      return {
        userId: id,
        fullName: member.user.fullName,
        email: member.user.email,
        role: member.role.key as RoleKey,
        status: member.status,
        leadsAssigned: assignedBy.get(id)?._count._all ?? 0,
        leadsCreated: authoredBy.get(id)?._count._all ?? 0,
        activeLeads: activeBy.get(id)?._count._all ?? 0,
        wonLeads: wonCount,
        lostLeads: lostCount,
        wonValue: wonRow ? wonRevenue(wonRow._sum.wonValue, wonRow._sum.estimatedValue) : '0',
        pipelineValue: decimalString(activeBy.get(id)?._sum.estimatedValue),
        conversionRate: percentage(wonCount, wonCount + lostCount),
        openFollowUps: openMap.get(id)?._count._all ?? 0,
        overdueFollowUps: overdueMap.get(id)?._count._all ?? 0,
        completedFollowUps: completed,
        followUpCompletionRate: percentage(completed, scheduled),
        lastActivityAt: activityMap.get(id)?._max.createdAt?.toISOString() ?? null,
        activityCount: activityMap.get(id)?._count._all ?? 0,
      };
    });

    return {
      range: toReportRange(range),
      scope: visibility,
      // Busiest first, so the row a manager needs is at the top.
      members: rows.sort((a, b) => b.activeLeads - a.activeLeads || a.fullName.localeCompare(b.fullName)),
    };
  }

  /** Totals used by the team page header, so it need not re-derive them. */
  private resolve(
    query: { preset?: string | undefined; from?: string | undefined; to?: string | undefined },
    timezone: string,
  ): DateRange {
    try {
      return resolveDateRange(query, timezone);
    } catch (error) {
      if (error instanceof DateRangeError) {
        throw AppException.validation('Invalid date range.', { range: [error.message] });
      }
      throw error;
    }
  }
}

function toReportRange(range: DateRange): ReportRange {
  return {
    preset: range.preset,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    fromDate: range.fromDate,
    toDate: range.toDate,
    timezone: range.timezone,
  };
}

export { CONTACT_ACTIVITIES, WHATSAPP_ACTIVITIES };
