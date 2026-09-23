import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { ProductsRepository } from './products.repository';
import { ProductMappingRepository } from './product-mapping.repository';

/**
 * Attaching products to leads that already exist.
 *
 * The one rule that matters: NOTHING IS GUESSED. Existing leads carry free text
 * like "White onion powder 25kg requirement", and a substring match would
 * cheerfully file "onion storage crates" under White Onion Powder. A wrong
 * mapping is worse than an absent one — it produces a confident KPI that is
 * quietly false, and nobody discovers it until the number is quoted in a
 * meeting.
 *
 * So this offers SUGGESTIONS and applies only what a person explicitly chose.
 * The free-text `productInterest` is never modified: it is the evidence of what
 * was actually asked for, and the product is only a grouping key placed
 * alongside it.
 */
@Injectable()
export class ProductMappingService {
  constructor(
    private readonly leads: ProductMappingRepository,
    private readonly products: ProductsRepository,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Leads with no product yet, newest first.
   *
   * `Lead` is tenant-scoped, so this cannot reach another organization's
   * backlog.
   */
  async unmapped(filters: { limit?: number | undefined; search?: string | undefined }) {
    const limit = Math.min(filters.limit ?? 50, 200);
    const { items, total } = await this.leads.unmapped({ limit, search: filters.search });

    return {
      items: items.map((lead) => ({
        id: lead.id,
        leadNumber: lead.leadNumber,
        name: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim(),
        companyName: lead.companyName,
        productInterest: lead.productInterest,
        status: lead.status,
        createdAt: lead.createdAt.toISOString(),
      })),
      total,
      returned: items.length,
    };
  }

  /**
   * Products whose name appears in a lead's free text.
   *
   * A SUGGESTION only — never applied automatically. Matching is on the whole
   * product name appearing in the text, which is conservative on purpose: it
   * misses "wht onion pwdr" rather than inventing a match for it. A person
   * confirms every one.
   */
  async suggestions(leadId: string) {
    const lead = await this.leads.findLeadForSuggestion(leadId);

    if (!lead) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Lead not found.');
    }

    if (!lead.productInterest) return { leadId, suggestions: [] };

    const text = lead.productInterest.toLowerCase();
    const { items } = await this.products.list({ active: true, limit: 200, offset: 0 });

    return {
      leadId,
      suggestions: items
        .filter((product) => text.includes(product.name.toLowerCase()))
        .map((product) => ({ id: product.id, name: product.name, sku: product.sku })),
    };
  }

  /**
   * Applies a mapping a person chose.
   *
   * Both sides are re-checked against the tenant-scoped client, so neither the
   * product nor the leads can belong to another organization however the ids
   * were obtained.
   */
  async assign(
    input: { productId: string; leadIds: string[] },
    principal: TenantPrincipal,
  ): Promise<{ updated: number }> {
    if (input.leadIds.length === 0) {
      throw AppException.validation('Choose at least one lead to map.', {
        leadIds: ['must not be empty'],
      });
    }

    // Through the scoped repository: a foreign product id simply is not found.
    const product = await this.products.findById(input.productId);
    if (!product) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Product not found.');
    }

    /*
     * `updateMany` with the ids in the WHERE, so the tenant extension narrows
     * it. Any id belonging to another organization matches nothing and is
     * silently skipped rather than throwing — the count tells the caller how
     * many actually moved.
     *
     * `productInterest` is deliberately absent from `data`. The free text is
     * the record of what was asked for and is never overwritten.
     */
    const updated = await this.leads.assign(input.leadIds, input.productId, principal.userId);

    await this.audit.record({
      action: 'product.leads_mapped',
      entityType: 'product',
      entityId: input.productId,
      after: {
        product: product.name,
        requested: input.leadIds.length,
        // Recorded separately: a gap between the two means ids were passed
        // that this tenant cannot see.
        updated,
      },
    });

    return { updated };
  }
}
