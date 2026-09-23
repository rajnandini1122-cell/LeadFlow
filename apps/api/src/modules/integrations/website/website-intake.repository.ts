import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { IntakeStatus } from '../../../generated/prisma/enums';

export interface IntakeRecord {
  id: string;
  organizationId: string;
  source: string;
  externalEventId: string;
  status: IntakeStatus;
  payloadHash: string;
  receivedAt: Date;
  createdLeadId: string | null;
  matchedContactId: string | null;
  matchedLeadId: string | null;
}

/**
 * Intake persistence.
 *
 * `IntegrationIntake` is in TENANT_SCOPED_MODELS, so nothing here mentions
 * organizationId on a read — the extension narrows every query and fails closed
 * when the context is missing. Intake runs inside `runForOrganization`, which
 * pins the tenant with scoping left ON, so a bug in this module can only ever
 * touch the organization the integration is configured for.
 */
@Injectable()
export class WebsiteIntakeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Inserts, or reports that this event id is already taken.
   *
   * Deliberately not preceded by a "does it exist" read. Two identical
   * requests arriving together would both find nothing and both insert; the
   * unique index is the only thing that can decide between them.
   *
   * `skipDuplicates` compiles to INSERT ... ON CONFLICT DO NOTHING, so a
   * collision returns no rows instead of raising. That matters twice over: a
   * retry is the ORDINARY case here and does not deserve exception-driven
   * control flow, and a raised unique violation would abort the statement —
   * which on the in-process PGlite the development suite runs against takes
   * the whole connection down with it.
   *
   * Returns null when the row already existed; the caller then reads it and
   * answers with its receipt.
   */
  async create(input: {
    source: string;
    externalEventId: string;
    eventType: string;
    payloadHash: string;
    status: IntakeStatus;
    name?: string | undefined;
    email?: string | undefined;
    phone?: string | undefined;
    country?: string | undefined;
    company?: string | undefined;
    message?: string | undefined;
    productInterest?: string | undefined;
    sourcePage?: string | undefined;
    matchedContactId?: string | undefined;
    matchedLeadId?: string | undefined;
  }): Promise<IntakeRecord | null> {
    const [created] = await this.prisma.client.integrationIntake.createManyAndReturn({
      skipDuplicates: true,
      data: [
        {
          organizationId: this.tenantContext.requireOrganizationId(),
          source: input.source,
          externalEventId: input.externalEventId,
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          status: input.status,
          name: input.name ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          country: input.country ?? null,
          company: input.company ?? null,
          message: input.message ?? null,
          productInterest: input.productInterest ?? null,
          sourcePage: input.sourcePage ?? null,
          matchedContactId: input.matchedContactId ?? null,
          matchedLeadId: input.matchedLeadId ?? null,
        },
      ],
      select: SELECTION,
    });

    return created ?? null;
  }

  /** The row a retry collided with. Tenant-scoped like every other read. */
  async findByEventId(source: string, externalEventId: string): Promise<IntakeRecord | null> {
    return this.prisma.client.integrationIntake.findFirst({
      where: { source, externalEventId },
      select: SELECTION,
    });
  }

  /** Whether the configured tenant exists and can receive work. */
  async organizationIsUsable(): Promise<boolean> {
    const organization = await this.prisma.client.organization.findFirst({
      select: { status: true },
    });

    return organization?.status === 'ACTIVE';
  }

  /** The dialling region for a number submitted without one. */
  async organizationCountry(): Promise<string | undefined> {
    const organization = await this.prisma.client.organization.findFirst({
      select: { country: true },
    });

    return organization?.country ?? undefined;
  }

  /**
   * A customer who already looks like this submission.
   *
   * Read-only, and only on keys the CRM already treats as identity: the
   * canonical phone number, which is what duplicate detection compares on, and
   * the email address. Nothing is written, merged or overwritten — the whole
   * point is to record a signal for a person to act on.
   */
  async findLikelyMatch(input: {
    phone?: string | undefined;
    email?: string | undefined;
  }): Promise<{
    contactId?: string | undefined;
    leadId?: string | undefined;
  }> {
    const result: { contactId?: string; leadId?: string } = {};

    if (input.phone) {
      const contact = await this.prisma.client.contact.findFirst({
        where: { mobile: input.phone, deletedAt: null },
        select: { id: true },
      });
      if (contact) result.contactId = contact.id;

      const lead = await this.prisma.client.lead.findFirst({
        where: { mobile: input.phone, deletedAt: null, status: { notIn: ['WON', 'LOST'] } },
        select: { id: true },
      });
      if (lead) result.leadId = lead.id;
    }

    if (!result.contactId && input.email) {
      const contact = await this.prisma.client.contact.findFirst({
        where: { email: input.email, deletedAt: null },
        select: { id: true },
      });
      if (contact) result.contactId = contact.id;
    }

    return result;
  }
}

const SELECTION = {
  id: true,
  organizationId: true,
  source: true,
  externalEventId: true,
  status: true,
  payloadHash: true,
  receivedAt: true,
  createdLeadId: true,
  matchedContactId: true,
  matchedLeadId: true,
} as const;
