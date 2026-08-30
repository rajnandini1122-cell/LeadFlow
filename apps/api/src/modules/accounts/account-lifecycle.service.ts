import { Injectable, Logger } from '@nestjs/common';
import { AuditRepository, AUDIT_ACTIONS } from '../../common/audit/audit.repository';
import { AccountLifecycleRepository } from './account-lifecycle.repository';

/**
 * What happens to a relationship when an opportunity closes.
 *
 * The rule the whole feature turns on: WINNING A DEAL DOES NOT CREATE A
 * CUSTOMER RECORD. It promotes the one that is already there.
 *
 * Before accounts existed, "customer" was a company name typed onto a lead, so
 * a repeat customer's second win produced a second row that looked exactly like
 * a new customer. Every acquisition figure counted them twice and no retention
 * figure could be computed at all. Here the account is FOUND, never made, and a
 * lead with no account simply does nothing — the alternative is inventing a
 * company from a free-text field, which is how the mess started.
 *
 * Deliberately fail-soft. Every method swallows its own errors after logging
 * them, because none of this may roll back the thing that actually happened:
 * the deal was won, and a bookkeeping failure must not undo that. A missed
 * promotion is recoverable — recomputeFromLeads() rebuilds the picture from the
 * opportunity history, which is the source of truth.
 */
@Injectable()
export class AccountLifecycleService {
  private readonly logger = new Logger(AccountLifecycleService.name);

  constructor(
    private readonly repository: AccountLifecycleRepository,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Called when a lead is marked WON.
   *
   * Promotes to CUSTOMER and records the milestones every customer KPI counts
   * from. DORMANT and FORMER_CUSTOMER are promoted back too: someone who buys
   * again is a customer again, and that is the one automatic transition that
   * cannot be wrong.
   */
  async onLeadWon(input: {
    leadId: string;
    accountId: string | null;
    wonAt: Date;
    actorId: string;
  }): Promise<void> {
    if (!input.accountId) return;

    try {
      const account = await this.repository.findStatus(input.accountId);
      if (!account) return;

      const becomesCustomer = account.status !== 'CUSTOMER';

      await this.repository.promoteToCustomer({
        accountId: input.accountId,
        wonAt: input.wonAt,
        setFirstWonAt: account.firstWonAt === null,
        actorId: input.actorId,
      });

      if (becomesCustomer) {
        await this.audit.record({
          action: AUDIT_ACTIONS.ACCOUNT_STATUS_CHANGED,
          entityType: 'Account',
          entityId: input.accountId,
          before: { status: account.status },
          after: { status: 'CUSTOMER', reason: 'won opportunity', leadId: input.leadId },
        });
      }
    } catch (error) {
      // Logged loudly, never rethrown: the deal was won and that must stand.
      this.logger.error(
        { err: error, leadId: input.leadId, accountId: input.accountId },
        'Failed to promote account after a won lead — the lead itself is unaffected',
      );
    }
  }

  /**
   * Called when a lead is marked LOST.
   *
   * Deliberately does NOT downgrade anything. A customer with five won deals
   * and one lost one is still a customer; letting a single loss demote them
   * would make the customer count depend on whichever deal happened to close
   * most recently. Only the activity clock moves.
   */
  async onLeadLost(input: { accountId: string | null; lostAt: Date }): Promise<void> {
    if (!input.accountId) return;

    try {
      await this.repository.touch(input.accountId, input.lostAt);
    } catch (error) {
      this.logger.error(
        { err: error, accountId: input.accountId },
        'Failed to touch account after a lost lead',
      );
    }
  }

  /** Keeps the activity clock current. Drives the dormancy review list. */
  async touch(accountId: string | null): Promise<void> {
    if (!accountId) return;

    try {
      await this.repository.touch(accountId, new Date());
    } catch (error) {
      this.logger.debug({ err: error, accountId }, 'Failed to touch account activity');
    }
  }

  /**
   * Rebuilds an account's milestones and status from its opportunity history.
   *
   * The repair path, and the reason the fail-soft handlers above are safe: the
   * leads are the source of truth, so a promotion missed to a transient error
   * is recoverable by recomputing rather than by hunting for what went wrong.
   *
   * Never demotes. If a person deliberately set FORMER_CUSTOMER or DORMANT,
   * recomputation must not undo that judgement just because old wins exist —
   * those wins are exactly why they were a customer in the first place.
   */
  async recomputeFromLeads(accountId: string): Promise<void> {
    try {
      const account = await this.repository.findStatus(accountId);
      if (!account) return;

      const milestones = await this.repository.milestonesFromLeads(accountId);

      const hasWon = milestones.firstWonAt !== null;
      const status = hasWon && account.status === 'PROSPECT' ? 'CUSTOMER' : account.status;

      await this.repository.applyMilestones({
        accountId,
        status,
        firstWonAt: milestones.firstWonAt,
        lastWonAt: milestones.lastWonAt,
        lastActivityAt: milestones.lastActivityAt,
      });
    } catch (error) {
      this.logger.error({ err: error, accountId }, 'Failed to recompute account from leads');
    }
  }
}
