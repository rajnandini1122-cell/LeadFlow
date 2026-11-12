import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AppConfig } from '../../../common/config/config.module';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import { MailboxService } from '../mailbox/mailbox.service';
import { describeConnectionError, imapClient } from '../mailbox/mail-connection';
import { InboxRepository } from './inbox.repository';
import { MAX_INBOUND_BYTES, parseInbound, type InboundFacts } from './inbound-message';

const SYNC_EVERY_MS = 2 * 60_000;
const LEASE_MS = 10 * 60_000;
/** Messages read per mailbox per run; the rest wait for the next run. */
const BATCH = 200;

export interface SyncReport {
  mailboxes: number;
  read: number;
  replies: number;
  bounces: number;
  other: number;
  errors: number;
}

/**
 * Reads each organization's inbox for replies and bounces.
 *
 * Read-only on the mailbox (EXAMINE: no flag is set, nothing moved or deleted).
 * Incremental by UID, with the position saved after every message, so a
 * restart resumes where it stopped and re-reading a message changes nothing
 * (unique on mailbox + UIDVALIDITY + UID, and on Message-ID for activities).
 *
 * The first run starts from the newest message: LeadFlow tracks replies to
 * what it sends, it does not import a mailbox's history. Only a message whose
 * In-Reply-To/References names one of OUR Message-IDs is attached to a lead;
 * everything else is recorded as OTHER and attached to nobody — no contact or
 * lead is ever created from inbound mail.
 */
@Injectable()
export class InboxSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InboxSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repository: InboxRepository,
    private readonly tenantContext: TenantContextService,
    private readonly mailbox: MailboxService,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('EMAIL_DISPATCH_ENABLED')) return;
    this.timer = setInterval(
      () =>
        void this.syncAll().catch((e) =>
          this.logger.error(`inbox sync failed: ${(e as Error).message}`),
        ),
      SYNC_EVERY_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async syncAll(now = new Date()): Promise<SyncReport> {
    const report: SyncReport = {
      mailboxes: 0,
      read: 0,
      replies: 0,
      bounces: 0,
      other: 0,
      errors: 0,
    };
    if (this.running) return report;
    this.running = true;
    try {
      for (const organizationId of await this.repository.organizationsWithMailbox()) {
        await this.tenantContext.runForOrganization(organizationId, 'email inbox sync', () =>
          this.syncOne(now, report),
        );
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  /** One organization's inbox. Public for the "Sync now" button and tests. */
  async syncOne(now: Date, report: SyncReport): Promise<void> {
    const mailbox = await this.repository.mailbox();
    if (!mailbox) return;
    if (
      !(await this.repository.acquireSyncLease(mailbox.id, new Date(now.getTime() + LEASE_MS), now))
    )
      return;
    report.mailboxes++;

    let client: Awaited<ReturnType<typeof imapClient>> | undefined;
    let count = 0;
    try {
      client = await imapClient(this.mailbox.account(mailbox), this.mailbox.deps);
      await client.connect();
      const box = await client.mailboxOpen('INBOX', { readOnly: true });
      const uidValidity = BigInt(box.uidValidity);
      const newest = BigInt(Math.max(0, Number(box.uidNext ?? 1) - 1));

      if (
        mailbox.imapUidValidity === null ||
        mailbox.imapUidValidity !== uidValidity ||
        mailbox.imapLastUid === null
      ) {
        // First run, or the server renumbered the folder: start from now.
        await this.repository.finishSync(mailbox.id, {
          lastSyncAt: now,
          lastSyncError: null,
          lastSyncCount: 0,
          imapUidValidity: uidValidity,
          imapLastUid: newest,
        });
        await client.logout();
        return;
      }

      const from = mailbox.imapLastUid + 1n;
      if (from <= newest) {
        for await (const message of client.fetch(
          `${from}:*`,
          { uid: true, source: { start: 0, maxLength: MAX_INBOUND_BYTES } },
          { uid: true },
        )) {
          const uid = BigInt(message.uid);
          // "n:*" returns the last message even when it is older than n.
          if (uid < from) continue;
          await this.process(
            mailbox.id,
            uidValidity,
            uid,
            message.source ?? Buffer.alloc(0),
            now,
            report,
          );
          await this.repository.advance(mailbox.id, uidValidity, uid);
          count++;
          report.read++;
          if (count >= BATCH) break;
        }
      }
      await client.logout();
      await this.repository.finishSync(mailbox.id, {
        lastSyncAt: now,
        lastSyncError: null,
        lastSyncCount: count,
      });
    } catch (error) {
      report.errors++;
      try {
        client?.close();
      } catch {
        // already closed
      }
      await this.repository.finishSync(mailbox.id, {
        lastSyncAt: now,
        lastSyncError: describeConnectionError(error, 'IMAP'),
        lastSyncCount: count,
      });
    }
  }

  private async process(
    mailboxId: string,
    uidValidity: bigint,
    uid: bigint,
    source: Buffer,
    now: Date,
    report: SyncReport,
  ): Promise<void> {
    let facts: InboundFacts;
    try {
      facts = await parseInbound(source);
    } catch {
      // Unparseable: recorded so it is not read again, attached to nobody.
      await this.repository.recordInbound({
        mailboxId,
        uidValidity,
        uid,
        messageId: null,
        inReplyTo: null,
        fromAddress: null,
        subject: null,
        snippet: null,
        receivedAt: null,
        kind: 'OTHER',
        recipientId: null,
        leadId: null,
      });
      report.other++;
      return;
    }

    if (facts.bounce && facts.bounce.originalMessageIds.length > 0) {
      const [recipient] = await this.repository.recipientsByMessageIds(
        facts.bounce.originalMessageIds,
      );
      const recorded = await this.repository.recordInbound({
        mailboxId,
        uidValidity,
        uid,
        messageId: facts.messageId,
        inReplyTo: facts.inReplyTo,
        fromAddress: facts.fromAddress,
        subject: facts.subject,
        snippet: facts.bounce.diagnostic,
        receivedAt: facts.receivedAt,
        kind: recipient ? 'BOUNCE' : 'OTHER',
        recipientId: recipient?.id ?? null,
        leadId: recipient?.leadId ?? null,
      });
      if (!recorded || !recipient) {
        report.other++;
        return;
      }
      // A 4.x.x report is a delay notice, not a failure.
      if (facts.bounce.status?.startsWith('4')) {
        report.other++;
        return;
      }
      const response = `Bounced after acceptance${facts.bounce.status ? ` (${facts.bounce.status})` : ''}${facts.bounce.diagnostic ? `: ${facts.bounce.diagnostic}` : ''}`;
      await this.repository.markBounced(recipient.id, response, now);
      await this.repository.suppressBounce(recipient.email, recipient.campaignId);
      if (recipient.leadId) {
        const activityId = await this.repository.addActivity({
          leadId: recipient.leadId,
          type: 'EMAIL_FAILED',
          description: `Campaign email "${recipient.campaign.subject}" to ${recipient.email} bounced: ${response}`,
          metadata: {
            campaignId: recipient.campaignId,
            recipientId: recipient.id,
            email: recipient.email,
            outcome: 'BOUNCED',
            status: facts.bounce.status,
            serverResponse: facts.bounce.diagnostic,
          },
        });
        await this.repository.linkActivity(recorded.id, activityId);
      }
      report.bounces++;
      return;
    }

    const matches = await this.repository.recipientsByMessageIds(facts.referencedIds);
    // Most specific reference wins: the message replied to directly.
    const recipient =
      facts.referencedIds.map((id) => matches.find((m) => m.messageId === id)).find(Boolean) ??
      null;
    const kind = recipient ? 'REPLY' : 'OTHER';
    const recorded = await this.repository.recordInbound({
      mailboxId,
      uidValidity,
      uid,
      messageId: facts.messageId,
      inReplyTo: facts.inReplyTo,
      fromAddress: facts.fromAddress,
      subject: facts.subject,
      snippet: facts.snippet,
      receivedAt: facts.receivedAt,
      kind,
      recipientId: recipient?.id ?? null,
      leadId: recipient?.leadId ?? null,
    });
    if (!recorded || !recipient) {
      report.other++;
      return;
    }
    if (
      facts.messageId &&
      (await this.repository.alreadySeenMessageId(facts.messageId, recorded.id))
    ) {
      report.other++;
      return;
    }

    await this.repository.markReplied(recipient.id, facts.receivedAt ?? now);
    if (recipient.leadId) {
      const label = facts.autoReply ? 'Automatic reply' : 'Reply';
      const activityId = await this.repository.addActivity({
        leadId: recipient.leadId,
        type: 'EMAIL_REPLY_RECEIVED',
        description: `${label} from ${facts.fromAddress ?? recipient.email} to "${recipient.campaign.subject}"${facts.snippet ? `: ${facts.snippet}` : ''}`,
        metadata: {
          campaignId: recipient.campaignId,
          campaignName: recipient.campaign.name,
          recipientId: recipient.id,
          from: facts.fromAddress,
          subject: facts.subject,
          messageId: facts.messageId,
          receivedAt: (facts.receivedAt ?? now).toISOString(),
          attachments: facts.attachmentCount,
          autoReply: facts.autoReply,
          suggestFollowUp: !facts.autoReply,
        },
      });
      await this.repository.linkActivity(recorded.id, activityId);
      if (!facts.autoReply && recipient.lead?.assignedToId) {
        const name =
          [recipient.lead.firstName, recipient.lead.lastName].filter(Boolean).join(' ') ||
          recipient.lead.companyName ||
          recipient.email;
        await this.repository.notifyReply({
          userId: recipient.lead.assignedToId,
          leadId: recipient.leadId,
          inboundId: recorded.id,
          title: `${name} replied to "${recipient.campaign.subject}"`,
          body: facts.snippet
            ? `${facts.snippet.slice(0, 300)}\n\nSchedule a follow-up.`
            : 'Schedule a follow-up.',
        });
      }
    }
    report.replies++;
  }
}
