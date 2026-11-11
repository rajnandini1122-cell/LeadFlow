import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ERROR_CODES, type UnsubscribeInfo } from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { Public } from '../../auth/decorators/public.decorator';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import { ConsentRepository } from './consent.repository';
import { UnsubscribeRepository } from './unsubscribe.repository';
import { hashUnsubscribeToken, isWellFormedUnsubscribeToken } from './unsubscribe-token';

const NOT_FOUND = 'This unsubscribe link is not valid.';

/**
 * Unsubscribing. Public: nobody has to sign in, or have an account, to stop
 * receiving marketing email.
 *
 *   GET  — what the page shows (which organization), and CHANGES NOTHING, so a
 *          link scanner opening the URL cannot unsubscribe anyone.
 *   POST — unsubscribes. This is also the RFC 8058 one-click target that mail
 *          clients call from the List-Unsubscribe-Post header. Idempotent.
 *
 * The token is the only input, and it names one recipient of one organization.
 */
@ApiTags('email')
@Controller('email/unsubscribe')
export class UnsubscribeController {
  constructor(
    private readonly unsubscribes: UnsubscribeRepository,
    private readonly consents: ConsentRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditRepository,
  ) {}

  @Get(':token')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Which organization an unsubscribe link belongs to. Changes nothing.' })
  async info(@Param('token') token: string): Promise<UnsubscribeInfo> {
    const target = await this.resolve(token);
    return {
      organizationName: target.organizationName,
      alreadyUnsubscribed: target.unsubscribedAt !== null,
    };
  }

  @Post(':token')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Unsubscribe from this organization’s marketing email (RFC 8058 one-click target)',
  })
  async unsubscribe(@Param('token') token: string): Promise<UnsubscribeInfo> {
    const target = await this.resolve(token);
    if (target.unsubscribedAt === null) {
      const at = new Date();
      await this.tenantContext.runForOrganization(
        target.organizationId,
        'email unsubscribe',
        async () => {
          await this.consents.suppress(target.email, {
            reason: 'UNSUBSCRIBED',
            source: 'unsubscribe-link',
            campaignId: target.campaignId,
          });
          await this.consents.withdraw([target.email], {
            source: 'unsubscribe-link',
            note: null,
            by: null,
          });
          await this.unsubscribes.markRecipientUnsubscribed(target.recipientId, at);
          await this.audit.record({
            action: 'email.unsubscribed',
            organizationId: target.organizationId,
            entityType: 'EmailCampaignRecipient',
            entityId: target.recipientId,
            after: { campaignId: target.campaignId, via: 'unsubscribe-link' },
          });
        },
      );
    }
    return { organizationName: target.organizationName, alreadyUnsubscribed: true };
  }

  private async resolve(token: string) {
    if (!isWellFormedUnsubscribeToken(token))
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, NOT_FOUND);
    const target = await this.unsubscribes.findByTokenHash(hashUnsubscribeToken(token));
    if (!target) throw AppException.notFound(ERROR_CODES.NOT_FOUND, NOT_FOUND);
    return target;
  }
}
