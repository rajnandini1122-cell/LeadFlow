import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { PrismaTransaction } from '../../../common/prisma/transaction';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';

/** What a command looked like, for deciding whether a retry is the same one. */
export interface CommandFingerprint {
  requestId: string;
  actorRef: string;
  method: string;
  path: string;
  payloadHash: string;
  action: string;
}

/** An already-recorded command, and what it produced. */
export interface RecordedCommand {
  actorRef: string;
  method: string;
  path: string;
  payloadHash: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
}

/**
 * The control plane's idempotency ledger, and the counts a summary needs.
 *
 * `AdminControlCommand` is NOT in TENANT_SCOPED_MODELS, and that is deliberate
 * rather than an omission: every query here names organizationId explicitly,
 * because the control plane runs inside a tenant context it set itself from
 * configuration, and a ledger row's tenant is part of its identity rather than
 * a filter applied to it. The unique index is on (organization_id, request_id),
 * so the column has to be written and compared, not injected.
 */
@Injectable()
export class AdminControlRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Records a command, or reports that this request id is already spoken for.
   *
   * ON CONFLICT DO NOTHING through `skipDuplicates`, against the unique index
   * on (organization_id, request_id). Three properties follow from that, and
   * all three are load-bearing:
   *
   *   it does not RAISE, so a duplicate does not abort the caller's
   *   transaction — which matters because the mutation lives in that same
   *   transaction and a raised constraint would take it down;
   *
   *   a CONCURRENT duplicate blocks on the index until the first commits, then
   *   sees it. Two identical commands arriving together produce one mutation,
   *   decided by PostgreSQL rather than by a read;
   *
   *   the row exists only if the transaction commits. A failure anywhere in
   *   the command frees the request id to be tried again, which is what stops
   *   a crash from permanently recording something that never happened.
   */
  async claim(tx: PrismaTransaction, fingerprint: CommandFingerprint): Promise<boolean> {
    const organizationId = this.tenantContext.requireOrganizationId();

    const [created] = await tx.adminControlCommand.createManyAndReturn({
      skipDuplicates: true,
      data: [{ organizationId, ...fingerprint }],
      select: { id: true },
    });

    return created !== undefined;
  }

  /** The command already recorded under this request id, if there is one. */
  async findByRequestId(
    tx: PrismaTransaction,
    requestId: string,
  ): Promise<RecordedCommand | null> {
    const organizationId = this.tenantContext.requireOrganizationId();

    return tx.adminControlCommand.findFirst({
      where: { organizationId, requestId },
      select: {
        actorRef: true,
        method: true,
        path: true,
        payloadHash: true,
        action: true,
        entityType: true,
        entityId: true,
      },
    });
  }

  /** Records what the command produced, so a retry can re-read it. */
  async recordResult(
    tx: PrismaTransaction,
    requestId: string,
    result: { entityType?: string | undefined; entityId?: string | undefined },
  ): Promise<void> {
    const organizationId = this.tenantContext.requireOrganizationId();

    await tx.adminControlCommand.updateMany({
      where: { organizationId, requestId },
      data: {
        entityType: result.entityType ?? null,
        entityId: result.entityId ?? null,
      },
    });
  }

  /**
   * The counts a control-plane summary shows.
   *
   * Counts only, every one of them served by an index that already exists —
   * this is an operations dial, not a reporting system, and an unbounded scan
   * here would be a slow query somebody added by accident.
   */
  async summaryCounts(): Promise<{
    activeTeams: number;
    activeRules: number;
    activeTerritories: number;
    intakes: Record<string, number>;
    lastProcessingAt: Date | null;
  }> {
    const client = this.prisma.client;

    const [activeTeams, activeRules, activeTerritories, intakeGroups, latest] = await Promise.all([
      client.team.count({ where: { status: 'ACTIVE' } }),
      client.assignmentRule.count({ where: { status: 'ACTIVE' } }),
      client.territory.count({ where: { status: 'ACTIVE' } }),
      // One grouped query rather than four counts: same index, a quarter of
      // the round trips.
      client.integrationIntake.groupBy({ by: ['status'], _count: { _all: true } }),
      client.integrationIntake.findFirst({
        where: { lastProcessingAt: { not: null } },
        select: { lastProcessingAt: true },
        orderBy: { lastProcessingAt: 'desc' },
      }),
    ]);

    const intakes: Record<string, number> = {};
    for (const group of intakeGroups) {
      intakes[group.status] = group._count._all;
    }

    return {
      activeTeams,
      activeRules,
      activeTerritories,
      intakes,
      lastProcessingAt: latest?.lastProcessingAt ?? null,
    };
  }

  /** Runs a command and its ledger row in one transaction. */
  async transaction<T>(run: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(run, {
      /*
       * The same limits the intake pipeline uses, and for the same reason: a
       * control command may create a team, evaluate routing, or convert an
       * enquiry, and it holds locks while it does. Prisma's five-second
       * default is tuned for a short write, and rolling back a legitimate
       * command under ordinary contention is worse than waiting for it.
       */
      timeout: 30_000,
      maxWait: 20_000,
    });
  }
}
