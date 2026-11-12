import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { EmailMailbox, Prisma } from '../../../generated/prisma/client';

/** The organization's one mailbox row. Tenant-scoped: there is no way to name another organization's. */
@Injectable()
export class MailboxRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async find(): Promise<EmailMailbox | null> {
    return this.prisma.client.emailMailbox.findFirst({});
  }

  async create(
    data: Omit<Prisma.EmailMailboxUncheckedCreateInput, 'organizationId'>,
  ): Promise<EmailMailbox> {
    return this.prisma.client.emailMailbox.create({
      data: { ...data, organizationId: this.tenantContext.requireOrganizationId() },
    });
  }

  async update(id: string, data: Prisma.EmailMailboxUncheckedUpdateInput): Promise<EmailMailbox> {
    return this.prisma.client.emailMailbox.update({ where: { id }, data });
  }
}
