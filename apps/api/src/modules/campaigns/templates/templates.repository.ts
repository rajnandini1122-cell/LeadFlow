import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { EmailCampaignCategory, Prisma } from '../../../generated/prisma/client';

const ASSET_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  productId: true,
  createdAt: true,
  product: { select: { name: true } },
} as const;

@Injectable()
export class TemplatesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async listTemplates(includeArchived: boolean) {
    return this.prisma.client.emailTemplate.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { updatedAt: 'desc' }],
    });
  }

  async findTemplate(id: string) {
    return this.prisma.client.emailTemplate.findFirst({ where: { id } });
  }

  async createTemplate(data: {
    name: string;
    category: EmailCampaignCategory;
    subject: string;
    html: string;
    text: string;
    by: string | null;
  }) {
    return this.prisma.client.emailTemplate.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        name: data.name,
        category: data.category,
        subject: data.subject,
        html: data.html,
        text: data.text,
        createdBy: data.by,
        updatedBy: data.by,
      },
    });
  }

  async updateTemplate(id: string, data: Prisma.EmailTemplateUncheckedUpdateInput) {
    return this.prisma.client.emailTemplate.update({ where: { id }, data });
  }

  // --- assets -----------------------------------------------------------------

  async listAssets() {
    return this.prisma.client.emailAsset.findMany({
      where: { deletedAt: null },
      select: ASSET_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAssets(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.client.emailAsset.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: ASSET_SELECT,
    });
  }

  /** With the bytes — only for building messages. */
  async loadAssets(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.client.emailAsset.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, data: true },
    });
  }

  async productExists(productId: string): Promise<boolean> {
    return (await this.prisma.client.product.count({ where: { id: productId } })) > 0;
  }

  async createAsset(data: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    data: Buffer;
    productId: string | null;
    by: string | null;
  }) {
    return this.prisma.client.emailAsset.create({
      data: {
        organizationId: this.tenantContext.requireOrganizationId(),
        fileName: data.fileName,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        sha256: data.sha256,
        data: new Uint8Array(data.data),
        productId: data.productId,
        uploadedBy: data.by,
      },
      select: ASSET_SELECT,
    });
  }

  async deleteAsset(id: string): Promise<boolean> {
    const result = await this.prisma.client.emailAsset.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return result.count > 0;
  }
}
