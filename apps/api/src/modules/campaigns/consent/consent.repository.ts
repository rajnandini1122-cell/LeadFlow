import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { PrismaTransaction } from '../../../common/prisma/transaction';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type {
  EmailSuppression,
  EmailSuppressionReason,
  MarketingConsent,
  MarketingConsentBasis,
} from '../../../generated/prisma/client';

/** Suppressions that only the person themselves can undo — never an administrator. */
export const PERMANENT_SUPPRESSIONS: readonly EmailSuppressionReason[] = [
  'UNSUBSCRIBED',
  'COMPLAINT',
];

@Injectable()
export class ConsentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private db(tx?: PrismaTransaction) {
    return tx ?? this.prisma.client;
  }

  async consentsFor(
    emails: string[],
    tx?: PrismaTransaction,
  ): Promise<Map<string, MarketingConsent>> {
    if (emails.length === 0) return new Map();
    const rows = await this.db(tx).marketingConsent.findMany({ where: { email: { in: emails } } });
    return new Map(rows.map((row) => [row.email, row]));
  }

  async suppressionsFor(
    emails: string[],
    tx?: PrismaTransaction,
  ): Promise<Map<string, EmailSuppression>> {
    if (emails.length === 0) return new Map();
    const rows = await this.db(tx).emailSuppression.findMany({ where: { email: { in: emails } } });
    return new Map(rows.map((row) => [row.email, row]));
  }

  async grant(
    emails: string[],
    input: { basis: MarketingConsentBasis; source: string; note: string | null; by: string | null },
  ): Promise<void> {
    const now = new Date();
    for (const email of emails) {
      await this.prisma.client.marketingConsent.upsert({
        where: {
          organizationId_email: {
            organizationId: this.tenantContext.requireOrganizationId(),
            email,
          },
        },
        create: {
          organizationId: this.tenantContext.requireOrganizationId(),
          email,
          status: 'GRANTED',
          basis: input.basis,
          source: input.source,
          note: input.note,
          recordedBy: input.by,
          recordedAt: now,
        },
        update: {
          status: 'GRANTED',
          basis: input.basis,
          source: input.source,
          note: input.note,
          recordedBy: input.by,
          recordedAt: now,
          withdrawnAt: null,
        },
      });
    }
  }

  async withdraw(
    emails: string[],
    input: { source: string; note: string | null; by: string | null },
    tx?: PrismaTransaction,
  ): Promise<void> {
    const now = new Date();
    for (const email of emails) {
      await this.db(tx).marketingConsent.upsert({
        where: {
          organizationId_email: {
            organizationId: this.tenantContext.requireOrganizationId(),
            email,
          },
        },
        create: {
          organizationId: this.tenantContext.requireOrganizationId(),
          email,
          status: 'WITHDRAWN',
          basis: 'CONSENT',
          source: input.source,
          note: input.note,
          recordedBy: input.by,
          recordedAt: now,
          withdrawnAt: now,
        },
        update: {
          status: 'WITHDRAWN',
          source: input.source,
          note: input.note,
          recordedBy: input.by,
          withdrawnAt: now,
        },
      });
    }
  }

  /** Idempotent: an address already suppressed keeps its first reason, except that a stronger one replaces MANUAL/BOUNCED. */
  async suppress(
    email: string,
    input: {
      reason: EmailSuppressionReason;
      source: string;
      campaignId?: string | null;
      note?: string | null;
      by?: string | null;
    },
    tx?: PrismaTransaction,
  ): Promise<void> {
    const organizationId = this.tenantContext.requireOrganizationId();
    const existing = await this.db(tx).emailSuppression.findFirst({ where: { email } });
    if (existing) {
      const stronger =
        PERMANENT_SUPPRESSIONS.includes(input.reason) &&
        !PERMANENT_SUPPRESSIONS.includes(existing.reason);
      if (stronger) {
        await this.db(tx).emailSuppression.update({
          where: { id: existing.id },
          data: {
            reason: input.reason,
            source: input.source,
            campaignId: input.campaignId ?? null,
            note: input.note ?? null,
          },
        });
      }
      return;
    }
    await this.db(tx).emailSuppression.createMany({
      skipDuplicates: true,
      data: [
        {
          organizationId,
          email,
          reason: input.reason,
          source: input.source,
          campaignId: input.campaignId ?? null,
          note: input.note ?? null,
          createdBy: input.by ?? null,
        },
      ],
    });
  }

  async removeSuppression(email: string): Promise<EmailSuppression | null> {
    const existing = await this.prisma.client.emailSuppression.findFirst({ where: { email } });
    if (!existing) return null;
    await this.prisma.client.emailSuppression.deleteMany({ where: { id: existing.id } });
    return existing;
  }

  async listSuppressions(take: number): Promise<EmailSuppression[]> {
    return this.prisma.client.emailSuppression.findMany({ orderBy: { createdAt: 'desc' }, take });
  }

  /**
   * Every address this organization holds on a live lead or contact, with a
   * name and company for display. Bounded: the eligibility screen pages it.
   */
  async knownAddresses(search: string | null, limit: number) {
    const contains = search ? { contains: search, mode: 'insensitive' as const } : undefined;
    const [leads, contacts] = await Promise.all([
      this.prisma.client.lead.findMany({
        where: {
          deletedAt: null,
          email: { not: null },
          ...(contains
            ? {
                OR: [
                  { email: contains },
                  { firstName: contains },
                  { lastName: contains },
                  { companyName: contains },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          companyName: true,
          importBatchId: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.client.contact.findMany({
        where: {
          deletedAt: null,
          mergedIntoId: null,
          email: { not: null },
          ...(contains
            ? {
                OR: [
                  { email: contains },
                  { firstName: contains },
                  { lastName: contains },
                  { companyName: contains },
                ],
              }
            : {}),
        },
        select: { id: true, email: true, firstName: true, lastName: true, companyName: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);
    return { leads, contacts };
  }
}
