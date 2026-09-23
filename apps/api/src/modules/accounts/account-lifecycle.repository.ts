import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AccountStatus } from '../../generated/prisma/enums';

/**
 * Data access for relationship lifecycle changes.
 *
 * Split from AccountLifecycleService because the architecture rule allows
 * Prisma in `*.repository.ts` only — the service holds the decisions, this
 * holds the queries.
 *
 * Every write is `updateMany` with the id in the WHERE so the tenant extension
 * narrows it. `update` by unique id addresses a row directly and would reach
 * another organization's account if an id were ever guessed or mis-plumbed.
 */
@Injectable()
export class AccountLifecycleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findStatus(accountId: string) {
    return this.prisma.client.account.findFirst({
      where: { id: accountId },
      select: { id: true, name: true, status: true, firstWonAt: true },
    });
  }

  async promoteToCustomer(input: {
    accountId: string;
    wonAt: Date;
    setFirstWonAt: boolean;
    actorId: string;
  }): Promise<void> {
    await this.prisma.client.account.updateMany({
      where: { id: input.accountId },
      data: {
        status: 'CUSTOMER',
        // Set once and never again: overwriting it would move the acquisition
        // date forward on every repeat purchase, making a five-year customer
        // look like this month's win.
        ...(input.setFirstWonAt ? { firstWonAt: input.wonAt } : {}),
        lastWonAt: input.wonAt,
        lastActivityAt: input.wonAt,
        updatedBy: input.actorId,
      },
    });
  }

  async touch(accountId: string, at: Date): Promise<void> {
    await this.prisma.client.account.updateMany({
      where: { id: accountId },
      data: { lastActivityAt: at },
    });
  }

  /** The opportunity history an account's milestones are rebuilt from. */
  async milestonesFromLeads(accountId: string) {
    const [firstWon, lastWon, lastTouched] = await Promise.all([
      this.prisma.client.lead.findFirst({
        where: { accountId, status: 'WON', wonAt: { not: null }, deletedAt: null },
        orderBy: { wonAt: 'asc' },
        select: { wonAt: true },
      }),
      this.prisma.client.lead.findFirst({
        where: { accountId, status: 'WON', wonAt: { not: null }, deletedAt: null },
        orderBy: { wonAt: 'desc' },
        select: { wonAt: true },
      }),
      this.prisma.client.lead.findFirst({
        where: { accountId, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
    ]);

    return {
      firstWonAt: firstWon?.wonAt ?? null,
      lastWonAt: lastWon?.wonAt ?? null,
      lastActivityAt: lastTouched?.updatedAt ?? null,
    };
  }

  async applyMilestones(input: {
    accountId: string;
    status: AccountStatus;
    firstWonAt: Date | null;
    lastWonAt: Date | null;
    lastActivityAt: Date | null;
  }): Promise<void> {
    await this.prisma.client.account.updateMany({
      where: { id: input.accountId },
      data: {
        status: input.status,
        firstWonAt: input.firstWonAt,
        lastWonAt: input.lastWonAt,
        ...(input.lastActivityAt ? { lastActivityAt: input.lastActivityAt } : {}),
      },
    });
  }
}
