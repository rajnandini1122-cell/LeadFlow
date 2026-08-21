import { Injectable } from '@nestjs/common';
import type { LeadStatus } from '@leadflow/api-types';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { LeadsRepository } from '../leads/leads.repository';
import { resolveLeadVisibility, visibilityFilter } from '../leads/lead-visibility';
import { startOfDayInZone, windowFor } from '../follow-ups/follow-up-buckets';
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

    // Day boundaries come from the ORGANIZATION's timezone. Computing them in
    // the browser used the viewer's clock, so a manager travelling saw a
    // different "today" from the team they were managing.
    const startOfWeek = new Date(startOfDayInZone(timezone, now).getTime() - 6 * 86_400_000);
    const endOfToday = new Date(startOfDayInZone(timezone, now).getTime() + 86_400_000);

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
        value: decimal(row?._sum.estimatedValue),
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
        activeValue: sum(byStage.map((stage) => stage.value)),
        byStage,
      },
      outcomes: {
        won: wonCount,
        lost: lostCount,
        // Falls back to the estimate for deals closed before wonValue existed,
        // otherwise historical revenue would read as zero.
        wonValue: decimal(won?._sum.wonValue) !== '0'
          ? decimal(won?._sum.wonValue)
          : decimal(won?._sum.estimatedValue),
        // Open leads are not yet a loss, so only decided deals count.
        conversionRate: decided === 0 ? 0 : Math.round((wonCount / decided) * 100),
        newThisWeek,
      },
      contacts,
      nextActions: actions.map(toDashboardLead),
      recent: recent.map(toDashboardLead),
    };
  }
}

type Decimalish = { toString(): string } | null | undefined;

function decimal(value: Decimalish): string {
  return value == null ? '0' : value.toString();
}

/**
 * Money is summed as a string-safe decimal.
 *
 * Prisma returns NUMERIC as a Decimal precisely so it does not go through a
 * float; converting to Number here to add it up would reintroduce the rounding
 * error the column type exists to avoid.
 */
function sum(values: string[]): string {
  const total = values.reduce((carry, value) => carry + BigInt(scaled(value)), 0n);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(3, '0');
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);

  return `${negative ? '-' : ''}${whole}${fraction === '00' ? '' : `.${fraction}`}`;
}

/** Decimal string to an integer number of hundredths. */
function scaled(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}${fraction.padEnd(2, '0').slice(0, 2)}`;
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
