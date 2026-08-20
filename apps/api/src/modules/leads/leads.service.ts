import { Injectable } from '@nestjs/common';
import type { LeadPriority, LeadStatus, Paginated } from '@idea001/api-types';
import { AppException } from '../../common/errors/app.exception';
import { LeadsRepository } from './leads.repository';
import type { ListLeadsDto } from './dto/leads.dto';

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

@Injectable()
export class LeadsService {
  constructor(private readonly repository: LeadsRepository) {}

  async list(dto: ListLeadsDto): Promise<Paginated<LeadSummary>> {
    const limit = dto.limit ?? 25;
    const rows = await this.repository.list({
      status: dto.status,
      assignedToId: dto.assignedToId,
      search: dto.search,
      cursor: dto.cursor,
      limit,
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toSummary);

    return {
      items,
      hasMore,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async findOne(id: string): Promise<LeadSummary & { activities: unknown[] }> {
    const lead = await this.repository.findById(id);
    // Another tenant's lead and a non-existent lead are the same 404.
    if (!lead) throw AppException.leadNotFound();

    const activities = await this.repository.listActivities(id, 50);

    return {
      ...toSummary(lead),
      activities: activities.map((activity) => ({
        id: activity.id,
        type: activity.activityType,
        description: activity.description,
        performedBy: activity.performedBy,
        createdAt: activity.createdAt.toISOString(),
      })),
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
  estimatedValue: { toString(): string } | null;
  nextFollowUpAt: Date | null;
  createdAt: Date;
  assignedTo: { id: string; fullName: string } | null;
};

function toSummary(lead: LeadRow): LeadSummary {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();

  return {
    id: lead.id,
    leadNumber: lead.leadNumber,
    name: name || '(no name)',
    companyName: lead.companyName,
    mobile: lead.mobile,
    status: lead.status as LeadStatus,
    priority: lead.priority as LeadPriority,
    // Decimal is serialised as a string: JSON numbers are IEEE-754 doubles and
    // would silently round a large deal value.
    estimatedValue: lead.estimatedValue?.toString() ?? null,
    nextFollowUpAt: lead.nextFollowUpAt?.toISOString() ?? null,
    assignedTo: lead.assignedTo,
    createdAt: lead.createdAt.toISOString(),
  };
}
