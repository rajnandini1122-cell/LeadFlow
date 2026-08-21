import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

/**
 * Contact enquiry data access.
 *
 * `ContactEnquiry` is deliberately absent from TENANT_SCOPED_MODELS: the sender
 * is an anonymous visitor who belongs to no organization, so there is nothing
 * to scope it to. That means the writes below have no tenant context at all,
 * and the Prisma extension fails closed rather than guessing — hence the
 * explicit system scope on each one, with a stated reason.
 */
@Injectable()
export class ContactRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(input: {
    name: string;
    email: string;
    company?: string | undefined;
    phone?: string | undefined;
    message: string;
    source?: string | undefined;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<{ id: string }> {
    return this.tenantContext.runAsSystem('public contact form submission', () =>
      this.prisma.client.contactEnquiry.create({
        data: {
          name: input.name,
          email: input.email,
          company: input.company ?? null,
          phone: input.phone ?? null,
          message: input.message,
          source: input.source ?? null,
          ipAddress: input.ipAddress ?? null,
          // Truncated to the column width rather than rejected: a long user
          // agent is not the visitor's fault and must not lose their enquiry.
          userAgent: input.userAgent?.slice(0, 400) ?? null,
        },
        select: { id: true },
      }),
    );
  }

  async markNotified(id: string): Promise<void> {
    await this.tenantContext.runAsSystem('contact enquiry notified', async () => {
      await this.prisma.client.contactEnquiry.update({
        where: { id },
        data: { notifiedAt: new Date() },
      });
    });
  }
}
