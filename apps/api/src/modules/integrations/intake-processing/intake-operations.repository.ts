import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { IntakeStatus } from '../../../generated/prisma/enums';

/**
 * Reads for the intake operations queue.
 *
 * Separate from the processing repository on purpose: this one is only ever
 * read by a person through an authenticated request, and it holds none of the
 * locking the conversion pipeline needs. Keeping them apart means the locking
 * code has no read path that could accidentally skip a lock.
 *
 * `IntegrationIntake` is in TENANT_SCOPED_MODELS, so nothing here names
 * organizationId — another organization's queue is simply not found.
 */
@Injectable()
export class IntakeOperationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: {
    status?: IntakeStatus | undefined;
    source?: string | undefined;
    receivedFrom?: Date | undefined;
    receivedTo?: Date | undefined;
    limit: number;
    offset: number;
  }) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.receivedFrom || query.receivedTo
        ? {
            receivedAt: {
              ...(query.receivedFrom ? { gte: query.receivedFrom } : {}),
              ...(query.receivedTo ? { lt: query.receivedTo } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.integrationIntake.findMany({
        where,
        select: LIST_SELECT,
        // Newest first: an operations queue is read to find out what just
        // happened, unlike the sweep, which works oldest first so customers
        // are answered in the order they wrote in.
        orderBy: { receivedAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.client.integrationIntake.count({ where }),
    ]);

    return { items, total };
  }

  async findById(id: string) {
    return this.prisma.client.integrationIntake.findFirst({
      where: { id },
      select: DETAIL_SELECT,
    });
  }

  /**
   * Puts a blocked or failed enquiry back in the queue.
   *
   * Conditional on the status, so a row somebody else converted in between is
   * left alone: the predicate is what stops a retry racing a sweep into two
   * conversions. RECEIVED is the only status the pipeline claims, so this is
   * how retry hands the row to exactly the same locked path a sweep uses,
   * rather than opening a second way in.
   */
  async reopen(id: string): Promise<number> {
    const result = await this.prisma.client.integrationIntake.updateMany({
      where: { id, status: { in: ['BLOCKED', 'FAILED'] } },
      data: { status: 'RECEIVED' },
    });

    return result.count;
  }

  /** The enquiry behind one lead, for the source panel on lead detail. */
  async findByLeadId(leadId: string) {
    return this.prisma.client.integrationIntake.findFirst({
      where: { createdLeadId: leadId },
      select: {
        id: true,
        source: true,
        receivedAt: true,
        sourcePage: true,
        message: true,
        productInterest: true,
        resolvedTerritory: { select: { id: true, name: true } },
        matchedAssignmentRule: { select: { id: true, name: true } },
        assignedTeam: { select: { id: true, name: true } },
      },
    });
  }
}

/** Routing provenance, shared by both projections. */
const ROUTING_SELECT = {
  processingCode: true,
  failureReason: true,
  processingAttempts: true,
  lastProcessingAt: true,
  processedAt: true,
  resolvedTerritory: { select: { id: true, name: true } },
  matchedAssignmentRule: { select: { id: true, name: true } },
  assignedTeam: { select: { id: true, name: true } },
  createdLead: { select: { id: true, leadNumber: true } },
} as const;

/**
 * The queue row.
 *
 * No message, no email, no phone. A list is scanned, and the fields somebody
 * scans for are "did this become work and, if not, why" — the customer's
 * details belong on the record they open deliberately.
 */
const LIST_SELECT = {
  id: true,
  source: true,
  status: true,
  receivedAt: true,
  name: true,
  company: true,
  productInterest: true,
  sourcePage: true,
  assignedUser: { select: { id: true, fullName: true } },
  ...ROUTING_SELECT,
} as const;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  email: true,
  phone: true,
  country: true,
  message: true,
  matchedContactId: true,
  matchedLeadId: true,
} as const;
