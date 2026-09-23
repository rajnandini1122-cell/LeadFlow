import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * The product catalogue.
 *
 * `Product` is registered in TENANT_SCOPED_MODELS, so nothing here mentions
 * organizationId on a read — the extension narrows every query and fails closed
 * if the context is missing. That matters more than usual here: a product id is
 * what a lead references and what every KPI groups by, so an unscoped read
 * would let one tenant both see another's catalogue and attach a foreign
 * product to their own lead.
 */
@Injectable()
export class ProductsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The catalogue, with the lead figures each row needs.
   *
   * Counts come from the database, not from loading leads and counting them in
   * Node: a catalogue of 200 products would otherwise mean 200 queries or one
   * enormous result set.
   */
  async list(filters: {
    search?: string | undefined;
    category?: string | undefined;
    active?: boolean | undefined;
    limit: number;
    offset: number;
  }) {
    const where = {
      ...(filters.active === undefined ? {} : { active: filters.active }),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' as const } },
              { sku: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.product.findMany({
        where,
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        take: filters.limit,
        skip: filters.offset,
      }),
      this.prisma.client.product.count({ where }),
    ]);

    return { items, total };
  }

  async findById(id: string) {
    return this.prisma.client.product.findFirst({ where: { id } });
  }

  async findBySku(sku: string) {
    return this.prisma.client.product.findFirst({ where: { sku } });
  }

  /** Distinct categories in use, for the filter control. */
  async categories(): Promise<string[]> {
    const rows = await this.prisma.client.product.findMany({
      where: { category: { not: null } },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });

    return rows
      .map((row) => row.category)
      .filter((category): category is string => category !== null);
  }

  async create(input: {
    name: string;
    sku: string;
    category?: string | undefined;
    description?: string | undefined;
    active: boolean;
    actorId: string;
  }) {
    return this.prisma.client.product.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        name: input.name,
        sku: input.sku,
        category: input.category ?? null,
        description: input.description ?? null,
        active: input.active,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      },
    });
  }

  /**
   * Updates a product.
   *
   * `updateMany` with the id in the WHERE, so the tenant extension narrows it.
   * `update` by unique id would address a row directly and could reach another
   * organization's product if the id were guessed.
   */
  async update(id: string, data: Record<string, unknown>): Promise<number> {
    const result = await this.prisma.client.product.updateMany({
      where: { id },
      data,
    });
    return result.count;
  }

  /** How many leads reference this product. Decides whether it is safe to delete. */
  async leadCount(productId: string): Promise<number> {
    return this.prisma.client.lead.count({ where: { productId, deletedAt: null } });
  }

  /**
   * Removes a product that has never been used.
   *
   * Deliberately refuses to be the general case: once a product has leads it is
   * deactivated instead, because deleting it would take it out of last
   * quarter's numbers as well as this month's offering. The caller checks
   * `leadCount` first.
   */
  async deleteUnused(id: string): Promise<number> {
    const result = await this.prisma.client.product.deleteMany({ where: { id } });
    return result.count;
  }
}
