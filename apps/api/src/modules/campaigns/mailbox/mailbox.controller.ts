import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PERMISSIONS, type MailboxView, type MailConnectionTestResult } from '@leadflow/api-types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { userActor } from '../../../common/audit/mutation-actor';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import { MailboxService } from './mailbox.service';
import { InboxSyncService, type SyncReport } from '../inbox/inbox-sync.service';
import { MailboxSendingDto, SaveMailboxDto, SaveProviderDto } from './dto/mailbox.dto';

enum TestKind {
  smtp = 'smtp',
  imap = 'imap',
  provider = 'provider',
}

/**
 * Email Settings: the organization's own mailbox.
 *
 * Owner and Admin only. Nothing here ever returns the password — the view has
 * no field for it — and the connection tests send no email and change nothing
 * in the inbox.
 */
@ApiTags('email')
@Controller('email/mailbox')
export class MailboxController {
  constructor(
    private readonly mailbox: MailboxService,
    private readonly inbox: InboxSyncService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.EMAIL_SETTINGS_MANAGE)
  @ApiOperation({ summary: 'The email account settings (never the password)' })
  async view(): Promise<MailboxView> {
    return this.mailbox.view();
  }

  @Put()
  @RequirePermissions(PERMISSIONS.EMAIL_SETTINGS_MANAGE)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Save the email account',
    description:
      'Changing the server, port, security, username or password switches sending off until both connections are tested again.',
  })
  async save(
    @Body() dto: SaveMailboxDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<MailboxView> {
    return this.mailbox.save(dto, userActor(principal));
  }

  @Post('test/:kind')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.EMAIL_SETTINGS_MANAGE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Test the saved SMTP or IMAP connection. Sends no email.' })
  async test(
    @Param('kind', new ParseEnumPipe(TestKind)) kind: TestKind,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<MailConnectionTestResult> {
    return kind === TestKind.provider
      ? this.mailbox.testProvider(userActor(principal))
      : this.mailbox.test(kind, userActor(principal));
  }

  @Put('provider')
  @RequirePermissions(PERMISSIONS.EMAIL_SETTINGS_MANAGE)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Choose how campaigns are sent: SMTP or the Resend API (key and webhook secret are write-only)',
  })
  async provider(
    @Body() dto: SaveProviderDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<MailboxView> {
    return this.mailbox.saveProvider(dto, userActor(principal));
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.EMAIL_SETTINGS_MANAGE)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Read new replies and bounces from the inbox now (read-only)' })
  async sync(): Promise<SyncReport> {
    const report: SyncReport = {
      mailboxes: 0,
      read: 0,
      replies: 0,
      bounces: 0,
      other: 0,
      errors: 0,
    };
    await this.inbox.syncOne(new Date(), report);
    return report;
  }

  @Patch('sending')
  @RequirePermissions(PERMISSIONS.EMAIL_SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Turn the mailbox on or off for campaigns, and set its sending limits' })
  async sending(
    @Body() dto: MailboxSendingDto,
    @CurrentUser() principal: TenantPrincipal,
  ): Promise<MailboxView> {
    return this.mailbox.setSending(dto, userActor(principal));
  }
}
