import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { ProductsRepository } from './products.repository';
import type { CreateProductDto, UpdateProductDto } from './dto/products.dto';

/**
 * The product catalogue.
 *
 * Two rules shape everything here:
 *
 *   1. A SKU is unique within the organization. It is the human-stable
 *      identifier — the thing a spreadsheet import would key on — so two
 *      products sharing one would make both ambiguous.
 *
 *   2. A product with leads is DEACTIVATED, never deleted. Retiring something
 *      you no longer sell must not remove it from last quarter's figures.
 *      `active` governs what is offered on new leads; reporting ignores it.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly repository: ProductsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(filters: {
    search?: string | undefined;
    category?: string | undefined;
    active?: boolean | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }) {
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const { items, total } = await this.repository.list({
      search: filters.search,
      category: filters.category,
      active: filters.active,
      limit,
      offset,
    });

    return {
      items: items.map(toView),
      total,
      limit,
      offset,
    };
  }

  async categories(): Promise<string[]> {
    return this.repository.categories();
  }

  async findOne(id: string) {
    const product = await this.repository.findById(id);
    if (!product) throw this.notFound();
    return toView(product);
  }

  async create(dto: CreateProductDto, principal: TenantPrincipal) {
    /*
     * Checked before the insert so the message names the field, and enforced
     * by the unique index underneath so a race cannot produce two.
     */
    const existing = await this.repository.findBySku(dto.sku);
    if (existing) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        `A product with SKU "${dto.sku}" already exists.`,
      );
    }

    try {
      const product = await this.repository.create({
        name: dto.name,
        sku: dto.sku,
        category: dto.category,
        description: dto.description,
        active: dto.active ?? true,
        actorId: principal.userId,
      });

      await this.audit.record({
        action: 'product.created',
        entityType: 'product',
        entityId: product.id,
        after: { name: product.name, sku: product.sku, category: product.category },
      });

      return toView(product);
    } catch (error) {
      // Two requests agreed the SKU was free between the check and the insert.
      // The index decides; the message stays the same either way.
      if ((error as { code?: string }).code === 'P2002') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          `A product with SKU "${dto.sku}" already exists.`,
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateProductDto, principal: TenantPrincipal) {
    const before = await this.repository.findById(id);
    if (!before) throw this.notFound();

    if (dto.sku !== undefined && dto.sku !== before.sku) {
      const clash = await this.repository.findBySku(dto.sku);
      if (clash && clash.id !== id) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          `A product with SKU "${dto.sku}" already exists.`,
        );
      }
    }

    /*
     * Renaming is deliberately allowed, including on a product with history.
     *
     * Leads reference the ID, so nothing moves between products and no
     * historical figure changes. That is the whole reason this is a table
     * rather than a string on the lead.
     */
    const data: Record<string, unknown> = { updatedBy: principal.userId };
    if (dto.name !== undefined) data['name'] = dto.name;
    if (dto.sku !== undefined) data['sku'] = dto.sku;
    if (dto.category !== undefined) data['category'] = dto.category;
    if (dto.description !== undefined) data['description'] = dto.description;
    if (dto.active !== undefined) data['active'] = dto.active;

    const updated = await this.repository.update(id, data);
    if (updated === 0) throw this.notFound();

    await this.audit.record({
      action: 'product.updated',
      entityType: 'product',
      entityId: id,
      before: { name: before.name, sku: before.sku, active: before.active },
      after: data,
    });

    return this.findOne(id);
  }

  /**
   * Retires a product, or removes one that was never used.
   *
   * A product with leads is only ever deactivated: deleting it would take it
   * out of historical reporting, and the lead's free-text productInterest is
   * not a substitute for a grouping key. One that has never been referenced is
   * a mistake somebody made in the catalogue, and can go.
   */
  async deactivate(id: string, principal: TenantPrincipal) {
    const product = await this.repository.findById(id);
    if (!product) throw this.notFound();

    const leads = await this.repository.leadCount(id);

    if (leads === 0) {
      await this.repository.deleteUnused(id);
      await this.audit.record({
        action: 'product.deleted',
        entityType: 'product',
        entityId: id,
        before: { name: product.name, sku: product.sku, leadCount: 0 },
      });
      return { deleted: true, deactivated: false, leadCount: 0 };
    }

    await this.repository.update(id, { active: false, updatedBy: principal.userId });
    await this.audit.record({
      action: 'product.deactivated',
      entityType: 'product',
      entityId: id,
      before: { active: product.active },
      after: { active: false, leadCount: leads },
    });

    return { deleted: false, deactivated: true, leadCount: leads };
  }

  private notFound(): AppException {
    return AppException.notFound(ERROR_CODES.NOT_FOUND, 'Product not found.');
  }
}

function toView(product: {
  id: string;
  name: string;
  sku: string;
  category: string | null;
  description: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    category: product.category,
    description: product.description,
    active: product.active,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}
