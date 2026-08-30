import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Lead reads and writes for the product backfill.
 *
 * A repository rather than direct Prisma in the service, because that is where
 * tenant scoping is applied — `Lead` is in TENANT_SCOPED_MODELS, so every query
 * here is narrowed by the extension and fails closed without a context.
 */
@Injectable()
export class ProductMappingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Leads with no product yet, newest first. */
  async unmapped(filters: { limit: number; search?: string | undefined }) {
    const where = {
      productId: null,
      deletedAt: null,
      ...(filters.search
        ? { productInterest: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.lead.findMany({
        where,
        select: {
          id: true,
          leadNumber: true,
          firstName: true,
          lastName: true,
          companyName: true,
          productInterest: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: filters.limit,
      }),
      // Counted WITHOUT the search filter: the caller needs the size of the
      // whole backlog, not of the current page's filter.
      this.prisma.client.lead.count({ where: { productId: null, deletedAt: null } }),
    ]);

    return { items, total };
  }

  async findLeadForSuggestion(leadId: string) {
    return this.prisma.client.lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: { id: true, productInterest: true, productId: true },
    });
  }

  /**
   * Attaches a product to leads a person chose.
   *
   * `updateMany` with the ids in the WHERE, so the tenant extension narrows it:
   * an id from another organization matches nothing and is skipped rather than
   * throwing. The returned count is what actually moved.
   *
   * `productInterest` is deliberately absent from the data — the free text is
   * the record of what was asked for and is never overwritten.
   */
  async assign(leadIds: string[], productId: string, actorId: string): Promise<number> {
    const result = await this.prisma.client.lead.updateMany({
      where: { id: { in: leadIds }, deletedAt: null },
      data: { productId, updatedBy: actorId },
    });

    return result.count;
  }
}
