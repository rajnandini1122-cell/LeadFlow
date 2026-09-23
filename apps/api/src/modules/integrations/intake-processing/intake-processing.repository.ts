import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTransaction } from '../../../common/prisma/prisma.service';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { IntakeStatus } from '../../../generated/prisma/enums';

/** One intake waiting to be processed, and whose it is. */
export interface PendingIntake {
  id: string;
  organizationId: string;
}

/**
 * Data access for the conversion pipeline.
 *
 * Three things here cannot be expressed through Prisma's query API and are
 * written as narrow parameterised SQL instead. Each one is a LOCK, and each is
 * marked with the eslint exception the rule itself prescribes:
 *
 *   claiming an intake            SELECT ... FOR UPDATE SKIP LOCKED
 *   holding a team's rotation     SELECT ... FOR UPDATE
 *   serialising lead numbering    pg_advisory_xact_lock
 *
 * Prisma has no lock clause at all — there is no `findFirst({ lock: ... })` —
 * so the alternatives were a lock or no lock, and without one two workers
 * assign the same rotation slot to two different customers. Every value is
 * bound as a parameter; nothing is interpolated, and none of these statements
 * takes a value a user can influence beyond an id that has already been
 * tenant-scoped by the caller.
 *
 * The cross-tenant read is `pending()` and is deliberately the only one: the
 * sweep has to ask "what is waiting anywhere" before it can enter any tenant's
 * context. It returns ids and nothing else, and every subsequent query runs
 * inside `runWithTenant`.
 */
@Injectable()
export class IntakeProcessingRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Intakes waiting for conversion, across every tenant, oldest first.
   *
   * The one cross-tenant query in this module, and it returns ids only — no
   * name, no message, no phone number. `runAsSystem` with a stated reason is
   * the audited escape hatch for exactly this, and the alternative would be
   * asking every organization in turn whether it has work.
   *
   * Oldest first because the first-response SLA runs from arrival: a backlog
   * should be worked in the order customers wrote in, not in whatever order
   * the index happens to return.
   */
  async pending(limit: number): Promise<PendingIntake[]> {
    return this.tenantContext.runAsSystem('intake sweep: find unprocessed intakes', () =>
      this.prisma.client.integrationIntake.findMany({
        where: { status: 'RECEIVED' },
        select: { id: true, organizationId: true },
        orderBy: { receivedAt: 'asc' },
        take: limit,
      }),
    );
  }

  /**
   * Takes the intake's row lock, or reports that somebody else has it.
   *
   * SKIP LOCKED rather than waiting: a second worker that arrives while the
   * first is mid-conversion should move on to other work, not block a
   * connection for the length of a transaction. The row will still be there
   * next sweep if the first worker fails.
   *
   * The status predicate is inside the lock, so a retry of an already-converted
   * intake finds nothing and does nothing — which is what makes calling
   * process() twice produce one lead rather than two.
   */
  async claim(tx: PrismaTransaction, intakeId: string): Promise<boolean> {
    const organizationId = this.tenantContext.requireOrganizationId();

    // eslint-disable-next-line no-restricted-syntax -- Prisma has no lock clause; organizationId is bound explicitly and covered by test/tenant-isolation.e2e-spec.ts
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
        FROM integration_intakes
       WHERE id = ${intakeId}::uuid
         AND organization_id = ${organizationId}::uuid
         AND status = 'RECEIVED'
         FOR UPDATE SKIP LOCKED
    `;

    return rows.length > 0;
  }

  /** The intake itself, read inside the transaction that holds its lock. */
  async load(tx: PrismaTransaction, intakeId: string) {
    return tx.integrationIntake.findFirst({
      where: { id: intakeId },
      select: {
        id: true,
        source: true,
        status: true,
        name: true,
        email: true,
        phone: true,
        country: true,
        company: true,
        productInterest: true,
        receivedAt: true,
        createdLeadId: true,
        processingAttempts: true,
      },
    });
  }

  /**
   * The rotation position for one team, locked for this transaction.
   *
   * Two steps, and both are necessary. The insert is idempotent — ON CONFLICT
   * DO NOTHING through `skipDuplicates`, so two workers meeting a team for the
   * first time produce one cursor rather than a unique violation. The SELECT
   * then takes the row's exclusive lock, which is what actually serialises the
   * rotation: without it two transactions read sequence 7, both choose
   * `eligible[7 % n]`, and the same salesperson gets both customers while the
   * next person in the rotation gets neither.
   *
   * Returns the sequence to use. The caller advances it only if the whole
   * conversion commits.
   */
  async lockCursor(tx: PrismaTransaction, teamId: string): Promise<bigint> {
    const organizationId = this.tenantContext.requireOrganizationId();

    await tx.teamAssignmentCursor.createManyAndReturn({
      skipDuplicates: true,
      data: [{ organizationId, teamId }],
      select: { id: true },
    });

    // eslint-disable-next-line no-restricted-syntax -- Prisma has no lock clause; organizationId is bound explicitly and covered by test/tenant-isolation.e2e-spec.ts
    const rows = await tx.$queryRaw<{ sequence: bigint }[]>`
      SELECT sequence
        FROM team_assignment_cursors
       WHERE team_id = ${teamId}::uuid
         AND organization_id = ${organizationId}::uuid
         FOR UPDATE
    `;

    const current = rows[0]?.sequence;
    if (current === undefined) {
      // The insert above guarantees the row exists and the lock guarantees
      // nobody removed it. Reaching here would mean the team was deleted
      // mid-transaction, which the foreign key prevents.
      throw new Error(`Assignment cursor for team ${teamId} disappeared mid-transaction`);
    }

    return current;
  }

  /**
   * Advances the rotation by one.
   *
   * Called last, inside the same transaction as everything else, so a
   * conversion that fails for any reason consumes no turn. A cursor that
   * advanced on a rolled-back conversion would silently skip somebody in the
   * rotation, which is the exact unfairness this mechanism exists to avoid.
   */
  async advanceCursor(tx: PrismaTransaction, teamId: string): Promise<void> {
    await tx.teamAssignmentCursor.updateMany({
      where: { teamId },
      data: { sequence: { increment: 1 } },
    });
  }

  /**
   * An active lead for this mobile, read inside the transaction.
   *
   * The processing-time duplicate re-check. J1 asked this question when the
   * enquiry arrived; time has passed, and somebody may have created the
   * customer by hand in between. Asking again inside the lock is what closes
   * that window.
   */
  async activeLeadByMobile(tx: PrismaTransaction, mobile: string) {
    return tx.lead.findFirst({
      where: { mobile, deletedAt: null, status: { not: 'LOST' } },
      select: { id: true, leadNumber: true },
    });
  }

  /** The tenant's first-response SLA and dialling country, in one read. */
  async tenantPolicy(tx: PrismaTransaction): Promise<{ slaMinutes: number; country: string }> {
    const [settings, organization] = await Promise.all([
      tx.organizationSettings.findFirst({
        select: { websiteIntakeFirstFollowUpMinutes: true },
      }),
      tx.organization.findFirst({ select: { country: true } }),
    ]);

    return {
      // The column is NOT NULL with a default, so the fallback is only for an
      // organization whose settings row has not been created yet.
      slaMinutes: settings?.websiteIntakeFirstFollowUpMinutes ?? 60,
      country: organization?.country ?? 'IN',
    };
  }

  /**
   * Records what happened, whatever happened.
   *
   * One method for every outcome, so an intake always ends a processing run
   * with its attempt counted and its timestamp moved — including the runs that
   * changed nothing else. A blocked row that looked untouched would be
   * indistinguishable from one the sweep had never reached.
   */
  async recordOutcome(
    tx: PrismaTransaction,
    intakeId: string,
    outcome: {
      status: IntakeStatus;
      processingCode: string | null;
      failureReason: string | null;
      resolvedTerritoryId?: string | null;
      matchedAssignmentRuleId?: string | null;
      assignedTeamId?: string | null;
      assignedMembershipId?: string | null;
      assignedUserId?: string | null;
      createdLeadId?: string | null;
      matchedContactId?: string | null;
      matchedLeadId?: string | null;
      processedAt?: Date | null;
    },
  ): Promise<void> {
    await tx.integrationIntake.updateMany({
      where: { id: intakeId },
      data: {
        status: outcome.status,
        processingCode: outcome.processingCode,
        failureReason: outcome.failureReason,
        lastProcessingAt: new Date(),
        processingAttempts: { increment: 1 },
        ...(outcome.resolvedTerritoryId !== undefined
          ? { resolvedTerritoryId: outcome.resolvedTerritoryId }
          : {}),
        ...(outcome.matchedAssignmentRuleId !== undefined
          ? { matchedAssignmentRuleId: outcome.matchedAssignmentRuleId }
          : {}),
        ...(outcome.assignedTeamId !== undefined ? { assignedTeamId: outcome.assignedTeamId } : {}),
        ...(outcome.assignedMembershipId !== undefined
          ? { assignedMembershipId: outcome.assignedMembershipId }
          : {}),
        ...(outcome.assignedUserId !== undefined ? { assignedUserId: outcome.assignedUserId } : {}),
        ...(outcome.createdLeadId !== undefined ? { createdLeadId: outcome.createdLeadId } : {}),
        ...(outcome.matchedContactId !== undefined
          ? { matchedContactId: outcome.matchedContactId }
          : {}),
        ...(outcome.matchedLeadId !== undefined ? { matchedLeadId: outcome.matchedLeadId } : {}),
        ...(outcome.processedAt !== undefined ? { processedAt: outcome.processedAt } : {}),
      },
    });
  }

  /** Points the lead at the follow-up that was just created for it. */
  async setLeadNextFollowUp(tx: PrismaTransaction, leadId: string, at: Date): Promise<void> {
    await tx.lead.updateMany({ where: { id: leadId }, data: { nextFollowUpAt: at } });
  }

  /**
   * Runs the whole conversion in one transaction.
   *
   * The limits are raised from Prisma's defaults on purpose, and the defaults
   * are the wrong shape for this rather than merely too small. Five seconds and
   * two seconds are tuned for a short write: read a row, update it, commit.
   * This transaction resolves geography, evaluates the routing table, takes a
   * rotation lock, creates a contact, a lead, two activities and a follow-up,
   * and it deliberately HOLDS LOCKS while it does — so a second conversion for
   * the same team queues behind it by design.
   *
   * Raising them is therefore not papering over slowness; it is admitting what
   * the transaction is. The cost of getting it wrong is asymmetric: too short
   * and a perfectly good conversion is rolled back under ordinary contention,
   * leaving an enquiry unconverted for no reason a person could diagnose.
   */
  async transaction<T>(run: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(run, {
      // How long the work itself may take once it has a connection.
      timeout: 30_000,
      // How long it may wait FOR a connection. Several conversions racing for
      // one team all queue on its cursor lock, and the ones at the back of the
      // queue are waiting legitimately rather than failing.
      maxWait: 20_000,
    });
  }
}
