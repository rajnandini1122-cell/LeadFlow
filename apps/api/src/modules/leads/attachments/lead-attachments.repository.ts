import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTransaction } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';

/**
 * Lead attachments. Tenant-scoped by the Prisma extension (LeadAttachment is
 * registered), so every read is confined to the caller's organization.
 *
 * Every LIST selects metadata only — never `data` — so a lead page with fifty
 * files does not pull fifty files' bytes.
 */
const METADATA = {
  id: true,
  leadId: true,
  kind: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  sha256: true,
  note: true,
  amount: true,
  uploadedBy: true,
  createdAt: true,
} as const;

@Injectable()
export class LeadAttachmentsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(
    tx: PrismaTransaction,
    input: {
      leadId: string;
      kind: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      data: Uint8Array;
      note?: string | undefined;
      amount?: number | undefined;
      uploadedBy: string;
    },
  ) {
    return tx.leadAttachment.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        leadId: input.leadId,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        // Prisma 7 takes a Uint8Array for a Bytes column, not a Node Buffer.
        data: new Uint8Array(input.data),
        note: input.note ?? null,
        amount: input.amount ?? null,
        uploadedBy: input.uploadedBy,
      },
      select: METADATA,
    });
  }

  async listForLead(leadId: string) {
    return this.prisma.client.leadAttachment.findMany({
      where: { leadId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: METADATA,
    });
  }

  async countForLead(leadId: string): Promise<number> {
    return this.prisma.client.leadAttachment.count({ where: { leadId, deletedAt: null } });
  }

  async findMetadata(id: string, leadId: string, tx?: PrismaTransaction) {
    return (tx ?? this.prisma.client).leadAttachment.findFirst({
      where: { id, leadId, deletedAt: null },
      select: METADATA,
    });
  }

  /** The one read that loads the bytes: an explicit download. */
  async findWithData(id: string, leadId: string) {
    return this.prisma.client.leadAttachment.findFirst({
      where: { id, leadId, deletedAt: null },
      select: { fileName: true, mimeType: true, sizeBytes: true, data: true },
    });
  }

  /** Soft delete, still-present only — a repeat removes nothing. */
  async softDelete(tx: PrismaTransaction, id: string, leadId: string, actorId: string): Promise<number> {
    const result = await tx.leadAttachment.updateMany({
      where: { id, leadId, deletedAt: null },
      data: { deletedAt: new Date(), deletedBy: actorId },
    });
    return result.count;
  }

  /** Display names for the uploader column, from members of THIS organization. */
  async memberNames(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.client.organizationUser.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, user: { select: { fullName: true } } },
    });
    return new Map(rows.map((row) => [row.userId, row.user.fullName]));
  }

  async organizationCurrency(): Promise<string> {
    const org = await this.prisma.client.organization.findFirst({ select: { currency: true } });
    return org?.currency ?? 'INR';
  }
}
