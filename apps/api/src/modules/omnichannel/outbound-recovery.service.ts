import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../../common/config/config.module';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { OmnichannelRepository } from './omnichannel.repository';

/**
 * Finalising sends that were claimed but never resolved.
 *
 * Phase E2 writes a PENDING row before calling Meta, so that a process dying
 * mid-send cannot lose the record and cause a duplicate. The cost of that
 * ordering is this: if the process dies, nothing ever comes back to close the
 * row, and it sits PENDING forever showing "Sending…" to a salesperson who has
 * no idea what happened.
 *
 * This sweep closes those rows — and does NOT resend them.
 *
 * That restraint is the entire point. When a process dies between calling Meta
 * and recording the answer, we genuinely do not know whether the customer got
 * the message. Resending would be a guess, and the failure mode of guessing
 * wrong is a customer receiving the same message twice from a business that
 * looks careless. So the row becomes UNCONFIRMED, which says exactly that, and
 * a person decides what to do.
 *
 * UNCONFIRMED is deliberately not FAILED. FAILED means the customer did not
 * get it, and a salesperson reading FAILED will quite reasonably send it again.
 */
@Injectable()
export class OutboundRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;

  /** Shown to the salesperson. Says what happened without over-claiming. */
  static readonly UNCONFIRMED_REASON =
    'Delivery could not be confirmed, and the message was not resent automatically. ' +
    'Check WhatsApp before sending it again.';

  constructor(
    private readonly config: AppConfig,
    private readonly repository: OmnichannelRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('OUTBOUND_RECOVERY_ENABLED')) {
      this.logger.log('Stale outbound message recovery is disabled.');
      return;
    }

    // One pass at startup, because the most likely reason a row is stranded is
    // that this process's predecessor died holding it.
    void this.sweep();

    const intervalMs = this.config.get('OUTBOUND_RECOVERY_INTERVAL_SECONDS') * 1000;
    this.timer = setInterval(() => void this.sweep(), intervalMs);

    // Never hold the process open. A maintenance sweep must not be the reason
    // a container refuses to shut down or a test suite hangs.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Close every outbound message that has been PENDING too long.
   *
   * Runs as system because stranded rows belong to every tenant at once and
   * there is no request to derive one from. It reads and writes nothing but
   * `messages.delivery_status` and `failure_reason` — no lead, no conversation,
   * no ownership.
   *
   * Returns how many rows it closed, for tests and for the log.
   */
  async sweep(): Promise<number> {
    const staleAfterMs = this.config.get('OUTBOUND_RECOVERY_AFTER_SECONDS') * 1000;
    const cutoff = new Date(Date.now() - staleAfterMs);

    try {
      const closed = await this.tenantContext.runAsSystem(
        'omnichannel: finalise stale outbound messages across all tenants',
        () =>
          this.repository.finaliseStalePending(cutoff, OutboundRecoveryService.UNCONFIRMED_REASON),
      );

      // Silent when there is nothing to do. A line every minute saying "0" is
      // how a log stops being read.
      if (closed > 0) {
        this.logger.warn(
          `Finalised ${closed} outbound message(s) as UNCONFIRMED after ` +
            `${this.config.get('OUTBOUND_RECOVERY_AFTER_SECONDS')}s pending. None were resent.`,
        );
      }

      return closed;
    } catch (error) {
      // A failed sweep is not worth taking the process down for; the next one
      // will find the same rows.
      this.logger.error(
        `Stale outbound message sweep failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return 0;
    }
  }
}
