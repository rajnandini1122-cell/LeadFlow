import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTransaction } from '../../../common/prisma/prisma.service';

const QUALIFICATION_FIELDS = {
  id: true,
  qualification: true,
  status: true,
  deactivatedAt: true,
  companyName: true,
  accountId: true,
  assignedToId: true,
  nextFollowUpAt: true,
  mobile: true,
  email: true,
  refinedAt: true,
  refinedBy: true,
  refinementOutcome: true,
  refinementNote: true,
} as const;

export type QualificationRow = {
  id: string;
  qualification: 'ROUGH' | 'REFINED';
  status: string;
  deactivatedAt: Date | null;
  companyName: string | null;
  accountId: string | null;
  assignedToId: string | null;
  nextFollowUpAt: Date | null;
  mobile: string | null;
  email: string | null;
  refinedAt: Date | null;
  refinedBy: string | null;
  refinementOutcome: string | null;
  refinementNote: string | null;
};

/**
 * Reads and writes for the Rough -> Refined workflow. Every write takes the
 * caller's transaction, which holds the lead's row lock
 * (FollowUpsRepository.inLeadTransaction), so a refine and a revert of the
 * same lead can never interleave.
 */
@Injectable()
export class LeadQualificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(leadId: string, tx?: PrismaTransaction): Promise<QualificationRow | null> {
    return (tx ?? this.prisma.client).lead.findFirst({
      where: { id: leadId, deletedAt: null },
      select: QUALIFICATION_FIELDS,
    }) as Promise<QualificationRow | null>;
  }

  /** An active point of contact with a phone, WhatsApp or email -- someone to talk to. */
  async hasReachableContact(leadId: string, tx?: PrismaTransaction): Promise<boolean> {
    const count = await (tx ?? this.prisma.client).leadContact.count({
      where: {
        leadId,
        inactiveAt: null,
        contact: {
          OR: [{ mobile: { not: null } }, { whatsapp: { not: null } }, { email: { not: null } }],
        },
      },
    });
    return count > 0;
  }

  async userName(userId: string | null): Promise<{ id: string; fullName: string } | null> {
    if (!userId) return null;
    return this.prisma.client.user.findFirst({
      where: { id: userId },
      select: { id: true, fullName: true },
    });
  }

  async markRefined(
    tx: PrismaTransaction,
    leadId: string,
    input: { outcome: string; note: string | null; actorId: string },
  ): Promise<void> {
    await tx.lead.updateMany({
      where: { id: leadId, qualification: 'ROUGH' },
      data: {
        qualification: 'REFINED',
        refinedAt: new Date(),
        refinedBy: input.actorId,
        refinementOutcome: input.outcome,
        refinementNote: input.note,
        updatedBy: input.actorId,
      },
    });
  }

  async markRough(tx: PrismaTransaction, leadId: string, actorId: string): Promise<void> {
    await tx.lead.updateMany({
      where: { id: leadId, qualification: 'REFINED' },
      data: {
        qualification: 'ROUGH',
        refinedAt: null,
        refinedBy: null,
        refinementOutcome: null,
        refinementNote: null,
        updatedBy: actorId,
      },
    });
  }

  /** The qualify-by date of a Rough lead (its next_follow_up_at). */
  async setQualifyBy(
    tx: PrismaTransaction,
    leadId: string,
    at: Date,
    actorId: string,
  ): Promise<void> {
    await tx.lead.updateMany({
      where: { id: leadId },
      data: { nextFollowUpAt: at, updatedBy: actorId },
    });
  }

  async openFollowUps(tx: PrismaTransaction, leadId: string): Promise<number> {
    return tx.followUp.count({ where: { leadId, status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } } });
  }
}
