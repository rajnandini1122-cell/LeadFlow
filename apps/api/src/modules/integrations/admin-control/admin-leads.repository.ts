import { Injectable } from '@nestjs/common';
import type { AdminControlLead, LeadPriority, LeadStatus } from '@leadflow/api-types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { AdminLeadQueryDto } from './dto/admin-leads.dto';

/**
 * Reading leads for the control plane.
 *
 * SEPARATE from `LeadsRepository`, and that separation is the point rather than
 * duplication. Three things follow from it:
 *
 *   * THE PROJECTION IS FIXED HERE. `LeadsRepository.findById` uses `include`,
 *     so every column added to `leads` appears in its result automatically —
 *     which is right for the CRM and wrong for a signed external boundary,
 *     where it would silently widen what an integration can read. This uses an
 *     explicit `select`, so widening the boundary takes a diff.
 *   * NO VISIBILITY FILTER, deliberately. The CRM restricts a lead list by who
 *     owns it; the control plane has no user to restrict by and already sees
 *     every team, rule and intake in the configured tenant. Tenant isolation is
 *     unaffected: every read here runs inside `runForOrganization`.
 *   * DEACTIVATED AND ARCHIVED LEADS ARE NEVER RETURNED. A record somebody took
 *     out of service is not work to hand off, and there is no filter to ask for
 *     them — see the DTO.
 */
@Injectable()
export class AdminLeadsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(query: AdminLeadQueryDto): Promise<{ items: AdminControlLead[]; total: number }> {
    // Named explicitly even though the tenant extension would add it. The
    // extension is a fail-closed backstop, not the thing a reader of this file
    // should have to know about to see that the query is scoped.
    const organizationId = this.tenantContext.requireOrganizationId();

    const where = {
      organizationId,
      deletedAt: null,
      deactivatedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}),
              ...(query.createdTo ? { lt: new Date(query.createdTo) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.client.lead.findMany({
        where,
        select: LEAD_SELECT,
        // Newest first: a handoff queue is read to find what has just become
        // ready, not to work through history.
        orderBy: { createdAt: 'desc' },
        take: query.limit ?? 25,
        skip: query.offset ?? 0,
      }),
      // The SAME where clause, so a total cannot describe a different set from
      // the page it sits above.
      this.prisma.client.lead.count({ where }),
    ]);

    return { items: rows.map(toAdminLead), total };
  }

  /** Another tenant's lead and a non-existent one are the same null. */
  async findById(id: string): Promise<AdminControlLead | null> {
    const row = await this.prisma.client.lead.findFirst({
      where: {
        id,
        organizationId: this.tenantContext.requireOrganizationId(),
        deletedAt: null,
        deactivatedAt: null,
      },
      select: LEAD_SELECT,
    });

    return row ? toAdminLead(row) : null;
  }
}

/**
 * EXPLICIT, not `include`.
 *
 * This is an external boundary. A column added to `leads` must not become
 * readable by a signed integration because somebody added a column.
 */
const LEAD_SELECT = {
  id: true,
  leadNumber: true,
  status: true,
  priority: true,
  firstName: true,
  lastName: true,
  companyName: true,
  mobile: true,
  email: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  productInterest: true,
  estimatedValue: true,
  accountId: true,
  createdAt: true,
  assignedTo: { select: { id: true, fullName: true } },
  /*
   * The originating submission, read through the relation.
   *
   * This is the direction that was missing: `submissionId` → intake →
   * `createdLead` already worked on this plane, but a lead gave no way back to
   * the submission it came from. `take: 1` because the relation is one-to-many
   * in the schema — a lead has at most one converting intake in practice, and
   * the schema does not enforce that, so the query says which one it means
   * rather than relying on it.
   */
  sourceIntakes: {
    select: { id: true, externalEventId: true },
    orderBy: { receivedAt: 'asc' as const },
    take: 1,
  },
} as const;

type LeadRow = {
  id: string;
  leadNumber: string;
  status: string;
  priority: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  mobile: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  productInterest: string | null;
  estimatedValue: { toString(): string } | null;
  accountId: string | null;
  createdAt: Date;
  assignedTo: { id: string; fullName: string } | null;
  sourceIntakes: { id: string; externalEventId: string }[];
};

function toAdminLead(row: LeadRow): AdminControlLead {
  const name = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
  const intake = row.sourceIntakes[0];

  return {
    id: row.id,
    leadNumber: row.leadNumber,
    status: row.status as LeadStatus,
    priority: row.priority as LeadPriority,
    name: name || null,
    companyName: row.companyName,
    mobile: row.mobile,
    email: row.email,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    productInterest: row.productInterest,
    // A string, because JSON numbers are IEEE-754 doubles and would silently
    // round a large deal value.
    estimatedValue: row.estimatedValue?.toString() ?? null,
    accountId: row.accountId,
    assignedTo: row.assignedTo,
    sourceSubmissionId: intake?.externalEventId ?? null,
    sourceIntakeId: intake?.id ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
