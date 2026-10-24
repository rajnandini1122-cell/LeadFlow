import { Injectable } from '@nestjs/common';
import type {
  ImportableField,
  LeadImportBatchSummary,
  LeadImportMappingTemplateSummary,
} from '@leadflow/api-types';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';

/**
 * Import provenance: which run created which leads, and the saved mappings.
 *
 * Every write names `organizationId` explicitly even though the Prisma tenant
 * extension would add it. That is the convention across this codebase: the
 * extension is a fail-closed backstop, not the thing a reader should have to
 * know about to see that a write is scoped.
 */
@Injectable()
export class LeadImportRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private get organizationId(): string {
    return this.tenantContext.requireOrganizationId();
  }

  /**
   * Opens a batch, before the first lead is written.
   *
   * `completedAt` stays null until the run finishes, so an interrupted import
   * is distinguishable from a finished one — and its leads are still
   * attributable, which is the whole point of writing this first.
   */
  async start(input: {
    fileName: string | null;
    mapping: Record<string, ImportableField>;
    totalRows: number;
    importedBy: string | null;
  }): Promise<string> {
    const created = await this.prisma.client.leadImportBatch.create({
      data: {
        organizationId: this.organizationId,
        fileName: input.fileName,
        mapping: input.mapping,
        totalRows: input.totalRows,
        importedBy: input.importedBy,
      },
      select: { id: true },
    });

    return created.id;
  }

  async complete(
    id: string,
    counts: { created: number; skipped: number; failed: number },
  ): Promise<void> {
    await this.prisma.client.leadImportBatch.updateMany({
      where: { id, organizationId: this.organizationId },
      data: {
        createdCount: counts.created,
        skippedCount: counts.skipped,
        failedCount: counts.failed,
        completedAt: new Date(),
      },
    });
  }

  async list(limit: number): Promise<LeadImportBatchSummary[]> {
    const rows = await this.prisma.client.leadImportBatch.findMany({
      where: { organizationId: this.organizationId },
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: BATCH_SELECT,
    });

    const importers = await this.importerNames(rows);

    return Promise.all(rows.map(async (row) => this.toSummary(row, importers)));
  }

  async findById(id: string): Promise<LeadImportBatchSummary | null> {
    const row = await this.prisma.client.leadImportBatch.findFirst({
      where: { id, organizationId: this.organizationId },
      select: BATCH_SELECT,
    });

    return row ? this.toSummary(row, await this.importerNames([row])) : null;
  }

  /**
   * Who ran each of these batches, by name.
   *
   * `importedBy` carries no foreign key — deliberately, so removing a user
   * cannot erase the record of what they did — which means there is no relation
   * to include and the names are resolved here instead.
   *
   * Looked up through `organizationUser`, which IS tenant-scoped, rather than
   * the global `user` table: the same rule `assignableUsers` follows. A former
   * member simply resolves to null and the batch still lists.
   */
  private async importerNames(rows: { importedBy: string | null }[]): Promise<ImporterNames> {
    const ids = [...new Set(rows.map((row) => row.importedBy).filter(isPresent))];
    if (ids.length === 0) return new Map();

    const memberships = await this.prisma.client.organizationUser.findMany({
      where: { userId: { in: ids } },
      select: { user: { select: { id: true, fullName: true } } },
    });

    return new Map(memberships.map((membership) => [membership.user.id, membership.user]));
  }

  /**
   * How many of a batch's leads are still live, and how many were taken out.
   *
   * Counted live rather than stored on the batch, because the answer changes
   * after the import finishes — somebody deactivating a wrongly imported lead
   * is exactly the workflow this supports, and a stored count would be stale
   * the moment it was used.
   *
   * Soft-deleted rows are excluded from both: an archived lead is in neither
   * category, and counting it as active would overstate what the batch still
   * holds.
   */
  private async toSummary(row: BatchRow, importers: ImporterNames): Promise<LeadImportBatchSummary> {
    const [activeLeads, deactivatedLeads] = await Promise.all([
      this.prisma.client.lead.count({
        where: {
          organizationId: this.organizationId,
          importBatchId: row.id,
          deletedAt: null,
          deactivatedAt: null,
        },
      }),
      this.prisma.client.lead.count({
        where: {
          organizationId: this.organizationId,
          importBatchId: row.id,
          deletedAt: null,
          deactivatedAt: { not: null },
        },
      }),
    ]);

    return {
      id: row.id,
      fileName: row.fileName,
      totalRows: row.totalRows,
      created: row.createdCount,
      skipped: row.skippedCount,
      failed: row.failedCount,
      activeLeads,
      deactivatedLeads,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      importedBy: (row.importedBy ? importers.get(row.importedBy) : undefined) ?? null,
      mapping: (row.mapping ?? {}) as Record<string, string>,
    };
  }

  // --- mapping templates -----------------------------------------------------

  async listTemplates(): Promise<LeadImportMappingTemplateSummary[]> {
    const rows = await this.prisma.client.leadImportMappingTemplate.findMany({
      where: { organizationId: this.organizationId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, mapping: true, createdAt: true },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mapping: (row.mapping ?? {}) as Record<string, ImportableField>,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Saves under a name, replacing a template of the same name.
   *
   * An upsert rather than a create: a tenant refining "Tally export" over three
   * attempts should end with one template, not three called
   * "Tally export (2)". The unique key is per tenant, so one organization
   * cannot overwrite another's.
   */
  async saveTemplate(input: {
    name: string;
    mapping: Record<string, ImportableField>;
    createdBy: string | null;
  }): Promise<LeadImportMappingTemplateSummary> {
    const organizationId = this.organizationId;

    const row = await this.prisma.client.leadImportMappingTemplate.upsert({
      where: { organizationId_name: { organizationId, name: input.name } },
      update: { mapping: input.mapping },
      create: {
        organizationId,
        name: input.name,
        mapping: input.mapping,
        createdBy: input.createdBy,
      },
      select: { id: true, name: true, mapping: true, createdAt: true },
    });

    return {
      id: row.id,
      name: row.name,
      mapping: (row.mapping ?? {}) as Record<string, ImportableField>,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** False when there was nothing to delete, including another tenant's row. */
  async deleteTemplate(id: string): Promise<boolean> {
    const { count } = await this.prisma.client.leadImportMappingTemplate.deleteMany({
      where: { id, organizationId: this.organizationId },
    });

    return count > 0;
  }
}

const BATCH_SELECT = {
  id: true,
  fileName: true,
  mapping: true,
  totalRows: true,
  createdCount: true,
  skippedCount: true,
  failedCount: true,
  importedBy: true,
  startedAt: true,
  completedAt: true,
} as const;

type BatchRow = {
  id: string;
  fileName: string | null;
  mapping: unknown;
  totalRows: number;
  createdCount: number;
  skippedCount: number;
  failedCount: number;
  importedBy: string | null;
  startedAt: Date;
  completedAt: Date | null;
};

type ImporterNames = Map<string, { id: string; fullName: string }>;

function isPresent(value: string | null): value is string {
  return value !== null;
}
