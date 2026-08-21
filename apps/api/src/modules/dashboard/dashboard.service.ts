import { Injectable } from '@nestjs/common';
import type { LeadStatus } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { LeadsRepository } from '../leads/leads.repository';
import { resolveLeadVisibility, visibilityFilter } from '../leads/lead-visibility';
import { windowFor } from '../follow-ups/follow-up-buckets';
import {
  addZonedDays,
  startOfZonedDay,
  zonedDate,
} from '../../common/utils/zoned-time';
import {
  decimalString,
  percentage,
  sumDecimals,
  wonRevenue,
  type Decimalish,
} from '../../common/utils/decimal';
import { DashboardRepository } from './dashboard.repository';

export interface DashboardLead {
  id: string;
  leadNumber: string;
  name: string;
  companyName: string | null;
  mobile: string | null;
  status: LeadStatus;
  priority: string;
  estimatedValue: string | null;
  nextFollowUpAt: string | null;
  assignedTo: { id: string; fullName: string } | null;
  createdAt: string;
}

export interface DashboardSummary {
  /** Whose figures these are — so the UI can label a rep's view honestly. */
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
  nextActions: DashboardLead[];
  recent: DashboardLead[];
}

const ACTIVE_STAGES: LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'FOLLOW_UP',
  'QUOTATION_SENT',
  'NEGOTIATION',
];

@Injectable()
export class DashboardService {
  constructor(
    private readonly repository: DashboardRepository,
    private readonly leads: LeadsRepository,
  ) {}

  /**
   * The whole dashboard in one request.
   *
   * One round trip rather than six: the screen is useless until every tile has
   * loaded, so staggering them only produces a longer sequence of layout jumps.
   */
  async summary(principal: TenantPrincipal): Promise<DashboardSummary> {
    const restrictToUserId = visibilityFilter(principal)?.assignedToId;
    const timezone = await this.leads.organizationTimezone();
    const now = new Date();

    // Day boundaries come from the ORGANIZATION's timezone, by calendar
    // arithmetic rather than fixed millisecond steps — a day on which the zone
    // changes offset is 23 or 25 hours long.
    const today = zonedDate(now, timezone);
    const startOfWeek = startOfZonedDay(addZonedDays(today, -6), timezone);
    const endOfToday = startOfZonedDay(addZonedDays(today, 1), timezone);

    const [stages, outcomes, newThisWeek, overdue, dueToday, upcoming, actions, recent, contacts] =
      await Promise.all([
        this.repository.pipelineByStage(restrictToUserId),
        this.repository.outcomes(restrictToUserId),
        this.repository.countCreatedSince(startOfWeek, restrictToUserId),
        this.repository.countFollowUps(windowFor('overdue', timezone, now), restrictToUserId),
        this.repository.countFollowUps(windowFor('today', timezone, now), restrictToUserId),
        this.repository.countFollowUps(windowFor('upcoming', timezone, now), restrictToUserId),
        this.repository.nextActions(endOfToday, 7, restrictToUserId),
        this.repository.recentLeads(5, restrictToUserId),
        this.repository.contactCount(),
      ]);

    const byStage = ACTIVE_STAGES.map((status) => {
      const row = stages.find((entry) => entry.status === status);
      return {
        status,
        count: row?._count._all ?? 0,
        value: decimalString(row?._sum.estimatedValue),
      };
    });

    const won = outcomes.find((entry) => entry.status === 'WON');
    const lost = outcomes.find((entry) => entry.status === 'LOST');
    const wonCount = won?._count._all ?? 0;
    const lostCount = lost?._count._all ?? 0;
    const decided = wonCount + lostCount;

    return {
      scope: resolveLeadVisibility(principal),
      timezone,
      followUps: { overdue, dueToday, upcoming },
      pipeline: {
        activeCount: byStage.reduce((total, stage) => total + stage.count, 0),
        activeValue: sumDecimals(byStage.map((stage) => stage.value)),
        byStage,
      },
      outcomes: {
        won: wonCount,
        lost: lostCount,
        wonValue: wonRevenue(won?._sum.wonValue, won?._sum.estimatedValue),
        // Open leads are not yet a loss, so only decided deals count.
        conversionRate: percentage(wonCount, decided),
        newThisWeek,
      },
      contacts,
      nextActions: actions.map(toDashboardLead),
      recent: recent.map(toDashboardLead),
    };
  }
}

type LeadRow = {
  id: string;
  leadNumber: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  mobile: string | null;
  status: string;
  priority: string;
  estimatedValue: Decimalish;
  nextFollowUpAt: Date | null;
  createdAt: Date;
  assignedTo: { id: string; fullName: string } | null;
};

function toDashboardLead(lead: LeadRow): DashboardLead {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();

  return {
    id: lead.id,
    leadNumber: lead.leadNumber,
    name: name || lead.companyName || lead.leadNumber,
    companyName: lead.companyName,
    mobile: lead.mobile,
    status: lead.status as LeadStatus,
    priority: lead.priority,
    estimatedValue: lead.estimatedValue?.toString() ?? null,
    nextFollowUpAt: lead.nextFollowUpAt?.toISOString() ?? null,
    assignedTo: lead.assignedTo,
    createdAt: lead.createdAt.toISOString(),
  };
}

export { ACTIVE_STAGES };
