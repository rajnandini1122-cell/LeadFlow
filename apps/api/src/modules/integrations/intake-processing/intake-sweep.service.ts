import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../common/config/config.module';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import { jobPrincipal } from '../../../queues/job-context';
import { IntakeProcessingRepository } from './intake-processing.repository';
import { IntakeProcessingService } from './intake-processing.service';

export interface IntakeSweepResult {
  claimed: number;
  converted: number;
  blocked: number;
  duplicates: number;
  skipped: number;
  failures: number;
}

/**
 * One pass over the intakes waiting to become leads.
 *
 * PostgreSQL is the authority, not the queue. The scheduler decides WHEN a
 * sweep runs; what is waiting is a question only the intake table can answer.
 * That is the difference between this and a design where each enquiry is one
 * Redis job: if Redis restarts and loses everything, the next sweep finds the
 * same rows and converts them, because they were never in Redis to begin with.
 *
 * Three properties, each load-bearing:
 *
 *   TENANT-SAFE. One cross-tenant query returns ids and organization ids;
 *   every conversion then runs inside `runWithTenant` for that ONE
 *   organization. A batch spanning three tenants enters and leaves context
 *   three times rather than running under a shared one, so a scoping mistake
 *   cannot reach across.
 *
 *   FAIL-SOFT PER INTAKE. One enquiry's failure is logged and the sweep
 *   continues. The failure mode of this job is a customer nobody calls, so one
 *   bad row must not stop the rest.
 *
 *   OFF BY DEFAULT. See `enabled`.
 */
@Injectable()
export class IntakeSweepService {
  private readonly logger = new Logger(IntakeSweepService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: IntakeProcessingRepository,
    private readonly processing: IntakeProcessingService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Whether this deployment converts intakes automatically.
   *
   * Default false, and checked here as well as at scheduler registration so a
   * manually triggered sweep obeys it too. The intake table is durable and may
   * hold a backlog that arrived before this code existed; a deploy that
   * switched itself on would convert all of it at once, assign it to real
   * salespeople and create a follow-up for each — easy to do, very hard to
   * undo.
   */
  get enabled(): boolean {
    return this.config.get('INTAKE_AUTO_PROCESSING_ENABLED');
  }

  async sweep(): Promise<IntakeSweepResult> {
    const result: IntakeSweepResult = {
      claimed: 0,
      converted: 0,
      blocked: 0,
      duplicates: 0,
      skipped: 0,
      failures: 0,
    };

    if (!this.enabled) return result;

    const pending = await this.repository.pending(this.config.get('INTAKE_SWEEP_BATCH_SIZE'));
    result.claimed = pending.length;

    for (const intake of pending) {
      try {
        // Per intake, not per batch. Two enquiries from two tenants in one
        // sweep run under two different contexts.
        await this.tenantContext.runWithTenant(jobPrincipal(intake.organizationId), async () => {
          const outcome = await this.processing.process(intake.id);

          if (outcome.result === 'CONVERTED') result.converted += 1;
          else if (outcome.result === 'BLOCKED') result.blocked += 1;
          else if (outcome.result === 'DUPLICATE') result.duplicates += 1;
          else result.skipped += 1;
        });
      } catch (error) {
        result.failures += 1;
        this.logger.error(
          { err: error, intakeId: intake.id },
          'Intake conversion failed — the enquiry is unchanged and will be retried',
        );
      }
    }

    if (result.converted || result.blocked || result.duplicates || result.failures) {
      this.logger.log(result, 'Intake sweep completed');
    }

    return result;
  }
}
