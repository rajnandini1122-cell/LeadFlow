import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../../common/config/config.module';
import { AppException } from '../../../common/errors/app.exception';
import { adminControlActor, type MutationActor } from '../../../common/audit/mutation-actor';
import type { PrismaTransaction } from '../../../common/prisma/transaction';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import { AdminControlRepository } from './admin-control.repository';
import { bodyDigest, verifyAdminSignature } from './admin-control-signature';

/** The authenticated facts a command carries, once the signature has held. */
export interface AdminCommandContext {
  requestId: string;
  actorRef: string;
  actor: MutationActor;
  method: string;
  path: string;
  payloadHash: string;
}

/** What a command produced, for the ledger and for a later retry. */
export interface CommandResult<T> {
  value: T;
  entityType?: string | undefined;
  entityId?: string | undefined;
}

/**
 * The Central Admin trust boundary.
 *
 * Three questions, in this order, and the order is the design:
 *
 *   1. Is this caller who they claim to be? An HMAC over the method, the path,
 *      the timestamp, the request id, the actor reference and the exact body
 *      bytes. Nothing in the request means anything until that passes.
 *
 *   2. Whose is it? Configuration says so. Never the request: a signature
 *      proves who is calling, not which tenant they may touch, and a body that
 *      could name an organization would turn one shared secret into access to
 *      all of them.
 *
 *   3. Have we done it already? The database decides, through a unique index on
 *      (organization_id, request_id) — and the row that index protects is
 *      written inside the same transaction as the mutation it records.
 *
 * WHAT IT IS NOT is a proxy. There is no route that takes a controller name, a
 * model, a path or a query; every operation is an explicit method on the
 * controller that calls an existing LeadFlow service. A generic dispatcher
 * would make the allowlist a runtime string comparison, which is the kind of
 * boundary that erodes one convenient exception at a time.
 */
@Injectable()
export class AdminControlService {
  private readonly logger = new Logger(AdminControlService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: AdminControlRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Whether this deployment offers the control plane at all. */
  get enabled(): boolean {
    return this.config.get('ADMIN_CONTROL_ENABLED');
  }

  /**
   * Authenticates a request, or throws the one error every failure produces.
   *
   * Deliberately a single message and a single code for every reason. A caller
   * debugging their own integration learns which request failed; a caller
   * probing it learns nothing about WHICH part was wrong — whether the secret
   * was close, whether the window is long, or whether that request id exists.
   * The reason is logged for us, never returned.
   */
  authenticate(input: {
    method: string;
    path: string;
    rawBody: Buffer | undefined;
    signature: string | undefined;
    timestamp: string | undefined;
    requestId: string | undefined;
    actorRef: string | undefined;
  }): AdminCommandContext {
    const result = verifyAdminSignature({
      ...input,
      signatureHeader: input.signature,
      timestampHeader: input.timestamp,
      secret: this.config.get('ADMIN_CONTROL_SIGNING_SECRET'),
    });

    if (!result.valid) {
      // The category only. Never the signature, the expected value, the
      // secret, or any part of the body.
      this.logger.warn({ reason: result.reason }, 'Rejected admin control request');
      throw AppException.unauthorized('This request could not be authenticated.');
    }

    // Narrowed by the verifier: it refuses the request without them.
    const requestId = input.requestId as string;
    const actorRef = input.actorRef as string;

    return {
      requestId,
      actorRef,
      actor: adminControlActor(actorRef),
      method: input.method.toUpperCase(),
      path: input.path,
      payloadHash: bodyDigest(input.rawBody),
    };
  }

  /**
   * Runs a READ inside the configured tenant's context.
   *
   * No ledger row. A read changes nothing, so recording every one of them would
   * fill the table with rows nobody will ever consult and make the ones that
   * matter harder to find. It still had to be signed to get here.
   */
  async read<T>(run: () => Promise<T>): Promise<T> {
    return this.tenantContext.runForOrganization(
      this.organizationId(),
      'admin control read',
      run,
    );
  }

  /**
   * Runs a MUTATION exactly once, whatever the caller does.
   *
   * The ledger row and the mutation share one transaction, and that single fact
   * is what makes this correct. Both of the orderings that look reasonable are
   * not:
   *
   *   claim, commit, then mutate — a crash in between permanently records a
   *   request that never ran, and the honest retry is refused as a duplicate of
   *   nothing;
   *
   *   mutate, commit, then claim — a crash in between loses the record, and the
   *   honest retry performs the mutation a second time.
   *
   * Here a failure rolls the row back with the mutation, leaving the request id
   * free; a success records both together.
   *
   * A repeat of a command that already succeeded does NOT replay the mutation.
   * It re-reads the authoritative record instead, which is why the ledger
   * stores an entity reference rather than a copy of the response — a stored
   * response would be stale the moment anything else touched the entity.
   */
  async mutate<T>(
    context: AdminCommandContext,
    action: string,
    run: (tx: PrismaTransaction, actor: MutationActor) => Promise<CommandResult<T>>,
    /**
     * Re-reads the result of a command that has already been performed.
     *
     * Takes the TRANSACTION, and must use it. Reaching for a pooled
     * connection here would deadlock: this runs inside the transaction that
     * holds one, and on a database serving a single connection there is no
     * second one to get.
     */
    replay: (
      tx: PrismaTransaction,
      recorded: { entityType: string | null; entityId: string | null },
    ) => Promise<T>,
  ): Promise<T> {
    return this.tenantContext.runForOrganization(
      this.organizationId(),
      'admin control command',
      async () => {
        return this.repository.transaction(async (tx) => {
          const claimed = await this.repository.claim(tx, {
            requestId: context.requestId,
            actorRef: context.actorRef,
            method: context.method,
            path: context.path,
            payloadHash: context.payloadHash,
            action,
          });

          if (!claimed) {
            const recorded = await this.repository.findByRequestId(tx, context.requestId);

            if (!recorded) {
              // The insert was refused and yet nothing is there: possible only
              // if the row was deleted in between. Nothing sensible to return.
              this.logger.error(
                { requestId: context.requestId },
                'Admin command conflicted with a row that then disappeared',
              );
              throw AppException.internal();
            }

            this.assertSameCommand(context, action, recorded);

            return replay(tx, recorded);
          }

          const result = await run(tx, context.actor);

          await this.repository.recordResult(tx, context.requestId, {
            entityType: result.entityType,
            entityId: result.entityId,
          });

          return result.value;
        });
      },
    );
  }

  /**
   * A retry must be the SAME command, not merely the same id.
   *
   * Everything the signature covered is compared. A caller that reuses an id
   * for different work is not retrying — they have a bug, or they are probing
   * whether an id has been used — and answering either with the first command's
   * result would be worse than refusing.
   *
   * The actor is compared too: the same instruction from a different
   * administrator is a different event, and letting it inherit the first one's
   * ledger row would attribute it to the wrong person.
   */
  private assertSameCommand(
    context: AdminCommandContext,
    action: string,
    recorded: {
      actorRef: string;
      method: string;
      path: string;
      payloadHash: string;
      action: string;
    },
  ): void {
    const same =
      recorded.method === context.method &&
      recorded.path === context.path &&
      recorded.payloadHash === context.payloadHash &&
      recorded.actorRef === context.actorRef &&
      recorded.action === action;

    if (same) return;

    /*
     * Says that the id is taken, and nothing about what it was used for.
     *
     * Naming the first command's path or actor would make this endpoint a way
     * to read the command history one guessed id at a time.
     */
    throw AppException.conflict(
      ERROR_CODES.CONFLICT,
      'This request id has already been used for a different command. Use a new request id.',
    );
  }

  /**
   * The one tenant this control plane administers.
   *
   * Read from configuration on every command rather than captured once, so a
   * misconfigured process cannot serve a stale value, and checked because the
   * cost of being wrong is writing into an unknown tenant.
   */
  private organizationId(): string {
    const organizationId = this.config.get('ADMIN_CONTROL_ORGANIZATION_ID');

    if (!organizationId) {
      // Unreachable in a validly configured process — the env schema refuses
      // to boot without it when the control plane is enabled.
      this.logger.error('Admin control is enabled with no organization configured');
      throw AppException.internal('This integration is not configured.');
    }

    return organizationId;
  }
}
