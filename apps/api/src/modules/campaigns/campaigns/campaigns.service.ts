import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  RECIPIENT_LIST_LIMIT,
  type EmailAudienceOptions,
  type EmailAudiencePreview,
  type EmailCampaignCounts,
  type EmailCampaignListItem,
  type EmailCampaignRecipientView,
  type EmailBroadcastExposure,
  type EmailBroadcastReviewView,
  type EmailBroadcastView,
  type EmailCampaignView,
  type EmailRecipientFilter,
  type EmailRenderedPreview,
  type EmailReplyView,
} from '@leadflow/api-types';
import { AppConfig } from '../../../common/config/config.module';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';
import {
  auditAttribution,
  userActor,
  type MutationActor,
} from '../../../common/audit/mutation-actor';
import { parseEncryptionKey } from '../../../common/crypto/secret-box';
import type { TenantPrincipal } from '../../../common/tenancy/tenant-context.service';
import type {
  EmailCampaign,
  EmailMailbox,
  EmailRecipientStatus,
} from '../../../generated/prisma/client';
import { ConsentRepository } from '../consent/consent.repository';
import { deriveUnsubscribeToken, unsubscribeKey } from '../consent/unsubscribe-token';
import { MailboxService } from '../mailbox/mailbox.service';
import { composeMessage, sendOnce } from '../mailbox/mail-connection';
import { sendViaResend, type ResendOutcome } from '../mailbox/resend-transport';
import {
  BROADCAST_MERGE_FIELDS,
  HANDED_TO_PROVIDER,
  type BroadcastState,
} from '../broadcast/broadcast-state';
import {
  BroadcastService,
  type ReviewAction,
  type ReviewOutcome,
} from '../broadcast/broadcast.service';
import { BroadcastRepository } from '../broadcast/broadcast.repository';
import { prepareContent, TemplatesService } from '../templates/templates.service';
import { TemplatesRepository } from '../templates/templates.repository';
import type { MergeValues } from '../content/email-content';
import { AudienceRepository, MAX_AUDIENCE } from './audience.repository';
import { SendingAllowlist } from '../content/sending-allowlist';
import { evaluateAudience, listRecipients, type AudienceResult } from './audience';
import { CampaignsRepository } from './campaigns.repository';
import { buildCampaignMessage, newMessageId } from './mail-message';
import type { AudiencePreviewDto, ConfirmCampaignDto, SaveCampaignDto } from './dto/campaigns.dto';

export const CAMPAIGN_AUDIT = {
  CREATED: 'email.campaign.created',
  UPDATED: 'email.campaign.updated',
  TEST_SENT: 'email.campaign.test_sent',
  TEST_RECIPIENT_REFUSED: 'email.campaign.test_recipient_refused',
  CONFIRMED: 'email.campaign.confirmed',
  PAUSED: 'email.campaign.paused',
  RESUMED: 'email.campaign.resumed',
  CANCELLED: 'email.campaign.cancelled',
  BROADCAST_RESOLVED: 'email.campaign.broadcast_resolved',
  BROADCAST_RESOLVE_REFUSED: 'email.campaign.broadcast_resolve_refused',
} as const;

const MAX_TEST_SENDS_PER_DAY = 20;
const MAX_SCHEDULE_DAYS = 90;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly repository: CampaignsRepository,
    private readonly audience: AudienceRepository,
    private readonly consents: ConsentRepository,
    private readonly templates: TemplatesService,
    private readonly templateRows: TemplatesRepository,
    private readonly mailbox: MailboxService,
    private readonly audit: AuditRepository,
    private readonly config: AppConfig,
    private readonly broadcasts: BroadcastService,
    private readonly broadcastRows: BroadcastRepository,
  ) {}

  // --- reading ---------------------------------------------------------------

  async list(): Promise<EmailCampaignListItem[]> {
    const campaigns = await this.repository.list(200);
    const ids = campaigns.map((c) => c.id);
    const [counts, engagement] = await Promise.all([
      this.repository.statusCounts(ids),
      this.repository.engagementByCampaign(ids),
    ]);
    return campaigns.map((campaign) => {
      const perStatus = counts.get(campaign.id) ?? new Map();
      return {
        id: campaign.id,
        name: campaign.name,
        category: campaign.category,
        purpose: campaign.purpose,
        status: campaign.status,
        subject: campaign.subject,
        scheduledAt: iso(campaign.scheduledAt),
        confirmedAt: iso(campaign.confirmedAt),
        createdAt: campaign.createdAt.toISOString(),
        counts: {
          eligible: campaign.eligibleCount,
          accepted: perStatus.get('ACCEPTED') ?? 0,
          failed: perStatus.get('FAILED') ?? 0,
          replies: engagement.get(campaign.id)?.replies ?? 0,
          unsubscribes: engagement.get(campaign.id)?.unsubscribes ?? 0,
        },
      };
    });
  }

  async get(id: string): Promise<EmailCampaignView> {
    return this.toView(await this.require(id));
  }

  async recipients(
    id: string,
    status: EmailRecipientStatus | undefined,
  ): Promise<EmailCampaignRecipientView[]> {
    await this.require(id);
    const rows = await this.repository.recipients(id, status, 2000);
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.displayName,
      leadId: row.leadId,
      status: row.status,
      attempts: row.attempts,
      lastSmtpCode: row.lastSmtpCode,
      lastResponse: row.lastResponse,
      skipReason: row.skipReason,
      acceptedAt: iso(row.acceptedAt),
      failedAt: iso(row.failedAt),
      repliedAt: iso(row.repliedAt),
      unsubscribedAt: iso(row.unsubscribedAt),
    }));
  }

  async replies(id: string): Promise<EmailReplyView[]> {
    await this.require(id);
    const rows = await this.repository.replies(id, 500);
    return rows.map((row) => ({
      id: row.id,
      fromAddress: row.fromAddress,
      subject: row.subject,
      snippet: row.snippet,
      receivedAt: iso(row.receivedAt),
      leadId: row.leadId,
      leadName: row.lead
        ? [row.lead.firstName, row.lead.lastName].filter(Boolean).join(' ') || row.lead.companyName
        : null,
      recipientEmail: row.recipient?.email ?? null,
    }));
  }

  // --- drafting --------------------------------------------------------------

  async create(dto: SaveCampaignDto, actor: MutationActor): Promise<EmailCampaignView> {
    const content = prepareContent(dto);
    if (dto.assetIds?.length) await this.templates.requireAssets(dto.assetIds);
    if (dto.templateId && !(await this.templateRows.findTemplate(dto.templateId))) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Template not found.');
    }
    const by = actor.kind === 'USER' ? actor.userId : null;
    const created = await this.repository.create({
      name: dto.name,
      category: dto.category,
      purpose: dto.purpose,
      templateId: dto.templateId ?? null,
      ...content,
      assetIds: dto.assetIds ?? [],
      filter: cleanFilter(dto.filter) as object,
      createdBy: by,
      updatedBy: by,
    });
    await this.audit.record({
      action: CAMPAIGN_AUDIT.CREATED,
      entityType: 'EmailCampaign',
      entityId: created.id,
      ...auditAttribution(actor),
      after: { name: dto.name, purpose: dto.purpose, category: dto.category },
    });
    return this.toView(created);
  }

  async update(id: string, dto: SaveCampaignDto, actor: MutationActor): Promise<EmailCampaignView> {
    const campaign = await this.require(id);
    if (campaign.status !== 'DRAFT') {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Only a draft can be edited. Cancel it and create a new campaign.',
      );
    }
    const content = prepareContent(dto);
    if (dto.assetIds?.length) await this.templates.requireAssets(dto.assetIds);
    const saved = await this.repository.transition(id, 'DRAFT', {
      name: dto.name,
      category: dto.category,
      purpose: dto.purpose,
      templateId: dto.templateId ?? null,
      ...content,
      assetIds: dto.assetIds ?? [],
      filter: cleanFilter(dto.filter) as object,
      updatedBy: actor.kind === 'USER' ? actor.userId : null,
    });
    if (!saved)
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'This campaign is no longer a draft.');
    await this.audit.record({
      action: CAMPAIGN_AUDIT.UPDATED,
      entityType: 'EmailCampaign',
      entityId: id,
      ...auditAttribution(actor),
      after: { name: dto.name, purpose: dto.purpose },
    });
    return this.get(id);
  }

  async audienceOptions(): Promise<EmailAudienceOptions> {
    return this.audience.options();
  }

  /**
   * Who the filter would reach, and why some would not. Counts for everyone with
   * campaign access; the sample of addresses only for someone who may see every
   * lead, so a manager cannot use a filter to read addresses outside their team.
   */
  async previewAudience(
    dto: AudiencePreviewDto,
    principal: TenantPrincipal,
  ): Promise<EmailAudiencePreview> {
    const result = await this.buildAudience(cleanFilter(dto.filter), dto.purpose);
    const mayList = principal.permissions.includes(PERMISSIONS.LEAD_VIEW_ALL);
    return {
      selected: result.selected,
      eligible: result.eligible.length,
      excluded: result.excluded,
      sample: mayList
        ? result.eligible
            .slice(0, 20)
            .map((m) => ({ email: m.email, name: m.displayName, company: m.merge.company ?? null }))
        : [],
      ...listRecipients(result, mayList, RECIPIENT_LIST_LIMIT),
    };
  }

  /** The message as the first eligible recipient would receive it (or with sample values). */
  async renderPreview(id: string): Promise<EmailRenderedPreview> {
    const campaign = await this.require(id);
    const organizationName = await this.repository.organizationName();
    const mailbox = await this.mailbox.find();
    let merge: MergeValues;
    let sampleRecipient: string | null = null;
    const queued = campaign.status === 'DRAFT' ? null : await this.repository.firstRecipient(id);
    if (queued) {
      merge = queued.mergeData as MergeValues;
      sampleRecipient = queued.email;
    } else {
      const audience = await this.buildAudience(
        campaign.filter as EmailRecipientFilter,
        campaign.purpose,
      );
      const first = audience.eligible[0];
      merge = first?.merge ?? {
        first_name: 'Asha',
        last_name: 'Rao',
        full_name: 'Asha Rao',
        company: 'Example Traders',
        city: 'Pune',
        organization: organizationName,
      };
      sampleRecipient = first?.email ?? null;
    }
    const assets = await this.templates.requireAssets(campaign.assetIds);
    const { rendered } = buildCampaignMessage({
      campaign,
      organizationName,
      mailboxAddress: mailbox?.emailAddress ?? 'sender@example.com',
      recipient: {
        email: sampleRecipient ?? 'recipient@example.com',
        displayName: null,
        messageId: '<preview@leadflow>',
        unsubscribeToken: 'PREVIEW',
      },
      merge,
      attachments: [],
      webBaseUrl: this.config.get('WEB_BASE_URL'),
    });
    return {
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: assets.map((a) => ({ fileName: a.fileName, sizeBytes: a.sizeBytes })),
      sampleRecipient,
    };
  }

  /**
   * Sends ONE copy to the signed-in user's own address or, when `to` names
   * another address, to that address only if the server approves it exactly:
   * it is on EMAIL_RECIPIENT_ALLOWLIST, the organization is
   * EMAIL_ALLOWED_ORGANIZATION_ID (EMAIL_SENDING_UNRESTRICTED does not lift
   * this), and it is not suppressed. An address that fails is refused and
   * audited — never silently replaced — so this can never mail strangers.
   *
   * It is still a real send, so it is switched off with the rest of email:
   * both EMAIL_DISPATCH_ENABLED and EMAIL_CAMPAIGNS_SENDING_ENABLED must be on.
   * The check comes first, before the campaign, the mailbox or any provider
   * is touched; unset switches read as off.
   */
  async testSend(
    id: string,
    principal: TenantPrincipal,
    to?: string,
  ): Promise<{ sentTo: string; accepted: boolean; message: string }> {
    this.requireTestSending();
    const campaign = await this.require(id);
    const user = await this.repository.userEmail(principal.userId);
    if (!user) throw AppException.forbidden();
    const allowlist = new SendingAllowlist(this.config);
    const own = user.email.trim().toLowerCase();
    const requested = to?.trim().toLowerCase();
    const recipientType = !requested || requested === own ? 'SELF' : 'APPROVED_ADDRESS';
    const recipient = recipientType === 'SELF' ? user.email : requested!;
    if (recipientType === 'SELF') {
      if (!allowlist.allows(principal.organizationId, user.email)) {
        throw AppException.validation(
          `${allowlist.refusal(principal.organizationId)} Your address (${user.email}) is not approved for test emails. To test another address, use "Send test to another approved email".`,
        );
      }
    } else {
      const reason = !allowlist.lists(principal.organizationId, recipient)
        ? 'NOT_APPROVED'
        : (await this.consents.suppressionsFor([recipient])).has(recipient)
          ? 'SUPPRESSED'
          : null;
      if (reason) {
        await this.audit.record({
          action: CAMPAIGN_AUDIT.TEST_RECIPIENT_REFUSED,
          entityType: 'EmailCampaign',
          entityId: id,
          ...auditAttribution(userActor(principal)),
          after: { recipient, reason },
        });
        throw AppException.validation(
          reason === 'SUPPRESSED'
            ? `${recipient} is suppressed (unsubscribed, bounced or blocked), so it cannot receive test emails.`
            : `${recipient} is not approved for test emails on this server. Only addresses an administrator has approved can receive them — ask for this one to be approved, or send the test to yourself.`,
        );
      }
    }
    const mailbox = await this.mailbox.require();
    const tested =
      mailbox.sendingProvider === 'RESEND' ? mailbox.providerOkAt : mailbox.lastSmtpOkAt;
    if (!tested) {
      throw AppException.validation(
        mailbox.sendingProvider === 'RESEND'
          ? 'Test Resend in Email settings first.'
          : 'Test the SMTP connection in Email settings first.',
      );
    }
    if ((await this.repository.testSendsToday()) >= MAX_TEST_SENDS_PER_DAY) {
      throw AppException.validation(`At most ${MAX_TEST_SENDS_PER_DAY} test emails per day.`);
    }
    const organizationName = await this.repository.organizationName();
    const assets = await this.templateRows.loadAssets(campaign.assetIds);
    const { options } = buildCampaignMessage({
      campaign: { ...campaign, subject: `[TEST] ${campaign.subject}` },
      organizationName,
      mailboxAddress: mailbox.emailAddress,
      fromAddress: mailbox.fromAddress,
      recipient: {
        email: recipient,
        displayName: recipientType === 'SELF' ? user.name : null,
        messageId: newMessageId(mailbox.emailAddress),
        unsubscribeToken: null,
      },
      // Merge fields show the sender's own values, for either recipient.
      merge: {
        first_name: user.name.split(' ')[0] ?? user.name,
        full_name: user.name,
        organization: organizationName,
      },
      attachments: assets,
      webBaseUrl: this.config.get('WEB_BASE_URL'),
    });

    const resend = mailbox.sendingProvider === 'RESEND';
    const outcome: ResendOutcome = resend
      ? await sendViaResend(
          this.mailbox.resendApiKey(mailbox),
          {
            from: `${organizationName.replace(/[\r\n"<>,;:@\\]/g, ' ').trim() || 'LeadFlow'} <${mailbox.fromAddress ?? mailbox.emailAddress}>`,
            to: recipient,
            replyTo: mailbox.emailAddress,
            subject: String(options.subject),
            html: String(options.html),
            text: String(options.text),
            headers: {},
            attachments: assets.map((a) => ({
              filename: a.fileName,
              content: Buffer.from(a.data).toString('base64'),
              contentType: a.mimeType,
            })),
            tags: [
              { name: 'campaign_id', value: campaign.id },
              { name: 'kind', value: 'test' },
            ],
            idempotencyKey: `leadflow-test-${randomUUID()}`,
          },
          this.mailbox.deps.fetchImpl,
        )
      : await sendOnce(
          this.mailbox.account(mailbox),
          { from: mailbox.fromAddress ?? mailbox.emailAddress, to: [recipient] },
          await composeMessage(options),
          this.mailbox.deps,
        );
    const accepted = outcome.kind === 'ACCEPTED';
    const message = accepted
      ? `Accepted by ${resend ? 'Resend' : mailbox.smtpHost} for ${recipient}. Acceptance is not proof of inbox delivery — check the inbox.`
      : outcome.kind === 'MAILBOX'
        ? resend
          ? 'Resend refused the API key or the sending domain. Check them in Email settings.'
          : 'The SMTP server refused the email account. Check the password in Email settings.'
        : `The test email was not accepted (${outcome.code ?? 'no reply code'}: ${outcome.response}).`;
    await this.audit.record({
      action: CAMPAIGN_AUDIT.TEST_SENT,
      entityType: 'EmailCampaign',
      entityId: id,
      ...auditAttribution(userActor(principal)),
      after: {
        accepted,
        recipient,
        recipientType,
        providerMessageId: outcome.providerMessageId ?? null,
      },
    });
    return { sentTo: recipient, accepted, message };
  }

  // --- sending -----------------------------------------------------------------

  /**
   * The final confirmation. Re-evaluates the audience, then — in ONE transaction —
   * moves the campaign out of DRAFT and writes one queued row per recipient.
   *
   * Idempotent on `submitKey`: a double click, a retried request or a second tab
   * confirms once and the replay gets the same answer. A different key on an
   * already-confirmed campaign is a conflict, not a second send.
   */
  async confirm(
    id: string,
    dto: ConfirmCampaignDto,
    principal: TenantPrincipal,
  ): Promise<EmailCampaignView> {
    const campaign = await this.require(id);
    if (campaign.submitKey === dto.submitKey && campaign.confirmedAt) return this.toView(campaign);
    if (campaign.status !== 'DRAFT') {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'This campaign has already been confirmed.',
      );
    }
    this.requireCustomerSending();
    const mailbox = await this.mailbox.require();
    if (!mailbox.enabled)
      throw AppException.validation('Turn the email account on in Email settings before sending.');
    // How it will be delivered is fixed now, so changing the provider later never
    // changes a campaign already in flight.
    const deliveryChannel =
      mailbox.sendingProvider === 'SMTP'
        ? 'SMTP'
        : campaign.purpose === 'PROMOTIONAL'
          ? 'RESEND_BROADCAST'
          : 'RESEND_EMAIL';
    if (deliveryChannel === 'RESEND_BROADCAST') this.requireBroadcastReady(campaign, mailbox);
    await this.templates.requireAssets(campaign.assetIds);

    const now = new Date();
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    if (scheduledAt && scheduledAt.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) {
      throw AppException.validation(
        `A campaign can be scheduled at most ${MAX_SCHEDULE_DAYS} days ahead.`,
      );
    }
    const startsLater = scheduledAt !== null && scheduledAt.getTime() > now.getTime() + 60_000;

    const audience = await this.buildAudience(
      campaign.filter as EmailRecipientFilter,
      campaign.purpose,
    );
    if (audience.eligible.length === 0)
      throw AppException.validation('No eligible recipients match this campaign.');
    if (audience.eligible.length !== dto.eligibleCount) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        `The audience changed: ${audience.eligible.length} recipients are eligible now, not ${dto.eligibleCount}. Review and confirm again.`,
      );
    }
    // Every recipient must be on the server's recipient allowlist (unless
    // sending is explicitly unrestricted): nothing unapproved is ever queued.
    const allowlist = new SendingAllowlist(this.config);
    const unapproved = audience.eligible.filter(
      (member) => !allowlist.allows(principal.organizationId, member.email),
    ).length;
    if (unapproved > 0) {
      throw AppException.validation(
        `${allowlist.refusal(principal.organizationId)} ${unapproved} of ${audience.eligible.length} recipients are not approved, so this campaign cannot be confirmed.`,
      );
    }

    const key = unsubscribeKey(parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY')));
    const recipients = audience.eligible.map((member) => {
      const recipientId = randomUUID();
      return {
        id: recipientId,
        email: member.email,
        leadId: member.leadId,
        contactId: member.contactId,
        displayName: member.displayName,
        mergeData: member.merge as object,
        messageId: newMessageId(mailbox.emailAddress),
        unsubscribeTokenHash: deriveUnsubscribeToken(key, recipientId).hash,
      };
    });

    try {
      await this.repository.inTransaction(async (tx) => {
        const moved = await this.repository.transition(
          id,
          'DRAFT',
          {
            status: startsLater ? 'SCHEDULED' : 'SENDING',
            submitKey: dto.submitKey,
            confirmedAt: now,
            confirmedBy: principal.userId,
            scheduledAt: startsLater ? scheduledAt : now,
            startedAt: startsLater ? null : now,
            selectedCount: audience.selected,
            eligibleCount: audience.eligible.length,
            excluded: audience.excluded,
            deliveryChannel,
            broadcastState: deliveryChannel === 'RESEND_BROADCAST' ? 'PENDING' : null,
          },
          tx,
        );
        if (!moved) throw new ConfirmRaceError();
        await this.repository.insertRecipients(id, recipients, tx);
      });
    } catch (error) {
      if (error instanceof ConfirmRaceError || isUniqueViolation(error)) {
        const current = await this.require(id);
        if (current.submitKey === dto.submitKey && current.confirmedAt) return this.toView(current);
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'This campaign has already been confirmed.',
        );
      }
      throw error;
    }

    await this.audit.record({
      action: CAMPAIGN_AUDIT.CONFIRMED,
      entityType: 'EmailCampaign',
      entityId: id,
      ...auditAttribution(userActor(principal)),
      after: {
        recipients: audience.eligible.length,
        excluded: audience.excluded,
        scheduledAt: startsLater ? scheduledAt!.toISOString() : null,
        mailbox: mailbox.emailAddress,
      },
    });
    return this.get(id);
  }

  async pause(id: string, actor: MutationActor): Promise<EmailCampaignView> {
    await this.refuseIfHandedToResend(id, 'paused');
    const moved = await this.repository.transition(
      id,
      { in: ['SCHEDULED', 'SENDING'] },
      {
        status: 'PAUSED',
        pausedAt: new Date(),
        pauseReason: 'Paused by a user.',
      },
    );
    if (!moved)
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'Only a scheduled or sending campaign can be paused.',
      );
    await this.audit.record({
      action: CAMPAIGN_AUDIT.PAUSED,
      entityType: 'EmailCampaign',
      entityId: id,
      ...auditAttribution(actor),
    });
    return this.get(id);
  }

  async resume(id: string, actor: MutationActor): Promise<EmailCampaignView> {
    this.requireCustomerSending();
    const mailbox = await this.mailbox.require();
    if (!mailbox.enabled)
      throw AppException.validation('Turn the email account on in Email settings before resuming.');
    const campaign = await this.require(id);
    if (campaign.broadcastState === 'NEEDS_REVIEW') {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'This broadcast needs review: choose Send again or Abandon instead of resuming.',
      );
    }
    const later = campaign.scheduledAt !== null && campaign.scheduledAt.getTime() > Date.now();
    const moved = await this.repository.transition(id, 'PAUSED', {
      status: later ? 'SCHEDULED' : 'SENDING',
      pausedAt: null,
      pauseReason: null,
      startedAt: campaign.startedAt ?? (later ? null : new Date()),
    });
    if (!moved)
      throw AppException.conflict(ERROR_CODES.CONFLICT, 'Only a paused campaign can be resumed.');
    await this.audit.record({
      action: CAMPAIGN_AUDIT.RESUMED,
      entityType: 'EmailCampaign',
      entityId: id,
      ...auditAttribution(actor),
    });
    return this.get(id);
  }

  /** Stops everything still queued. A message already being handed to the server finishes its one attempt. */
  async cancel(id: string, actor: MutationActor): Promise<EmailCampaignView> {
    const campaign = await this.require(id);
    if (campaign.deliveryChannel === 'RESEND_BROADCAST') {
      const state = campaign.broadcastState as BroadcastState;
      if (state === 'NEEDS_REVIEW') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'This broadcast needs review: choose Send again or Abandon, with a reason.',
        );
      }
      if (HANDED_TO_PROVIDER.includes(state)) {
        // Resend is asked to cancel; the live status decides what LeadFlow records.
        const result = await this.broadcasts.cancelAtProvider(campaign);
        await this.audit.record({
          action: CAMPAIGN_AUDIT.CANCELLED,
          entityType: 'EmailCampaign',
          entityId: id,
          ...auditAttribution(actor),
          after: { atProvider: true, ...result },
        });
        return this.get(id);
      }
    }
    let cancelledRecipients = 0;
    await this.repository.inTransaction(async (tx) => {
      const moved = await this.repository.transition(
        id,
        { in: ['DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED'] },
        { status: 'CANCELLED', cancelledAt: new Date() },
        tx,
      );
      if (!moved)
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'This campaign has already finished or been cancelled.',
        );
      cancelledRecipients = await this.repository.cancelQueued(id, tx);
    });
    await this.audit.record({
      action: CAMPAIGN_AUDIT.CANCELLED,
      entityType: 'EmailCampaign',
      entityId: id,
      ...auditAttribution(actor),
      after: { cancelledRecipients },
    });
    return this.get(id);
  }

  /** A person's decision on a broadcast that LeadFlow would not decide on its own. */
  /**
   * The one recovery path for a broadcast in NEEDS_REVIEW (API and campaign
   * page alike). Every attempt — decided or refused — is written to the
   * append-only email_broadcast_reviews table and to the audit log, with the
   * actor, the reason, and the state before and after.
   */
  async resolveBroadcast(
    id: string,
    action: ReviewAction,
    reason: string,
    expectedVersion: number,
    actor: MutationActor,
  ): Promise<EmailCampaignView> {
    this.requireCustomerSending();
    const campaign = await this.require(id);
    if (campaign.deliveryChannel !== 'RESEND_BROADCAST') {
      throw AppException.validation('Only a Resend broadcast can be resolved this way.');
    }
    let result: ReviewOutcome | null = null;
    let refusal: string | null = null;
    try {
      result = await this.broadcasts.resolveReview(campaign, action, expectedVersion);
    } catch (error) {
      refusal = error instanceof AppException ? error.message : 'Unexpected error';
      await this.recordReview(campaign, action, reason, null, refusal, actor);
      throw error;
    }
    await this.recordReview(campaign, action, reason, result, null, actor);
    return this.get(id);
  }

  private async recordReview(
    before: EmailCampaign,
    action: ReviewAction,
    reason: string,
    result: ReviewOutcome | null,
    refusal: string | null,
    actor: MutationActor,
  ): Promise<void> {
    const after = (await this.repository.find(before.id)) ?? before;
    const attribution = auditAttribution(actor);
    await this.broadcastRows.recordReview({
      campaignId: before.id,
      actorUserId: attribution.actorUserId,
      action,
      reason: reason.slice(0, 500),
      outcome: result?.outcome ?? 'refused',
      refusal: refusal?.slice(0, 500) ?? null,
      previousState: before.broadcastState,
      previousStatus: before.status,
      resultingState: after.broadcastState,
      resultingStatus: after.status,
      providerStatus: result?.providerStatus ?? after.broadcastProviderStatus,
      recipientsClosed: result?.recipientsClosed ?? 0,
    });
    await this.audit.record({
      action: result ? CAMPAIGN_AUDIT.BROADCAST_RESOLVED : CAMPAIGN_AUDIT.BROADCAST_RESOLVE_REFUSED,
      entityType: 'EmailCampaign',
      entityId: before.id,
      ...attribution,
      before: {
        broadcastState: before.broadcastState,
        status: before.status,
        broadcastVersion: before.broadcastVersion,
        broadcastError: before.broadcastError,
      },
      after: {
        action,
        reason,
        ...(result ?? { outcome: 'refused', refusal }),
        broadcastState: after.broadcastState,
        status: after.status,
      },
    });
  }

  // --- helpers -------------------------------------------------------------------

  /**
   * A broadcast Resend has been asked to send cannot be recalled from LeadFlow.
   * (Resend can cancel a queued broadcast, stopping only the emails not yet
   * delivered; that is done in Resend, and LeadFlow does not pretend otherwise.)
   */
  private async refuseIfHandedToResend(id: string, verb: string): Promise<void> {
    const campaign = await this.require(id);
    if (
      campaign.deliveryChannel === 'RESEND_BROADCAST' &&
      HANDED_TO_PROVIDER.includes(campaign.broadcastState as BroadcastState)
    ) {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        `This broadcast has already been handed to Resend and cannot be ${verb}. Cancel asks Resend to stop a queued or scheduled broadcast; emails already sent cannot be recalled.`,
      );
    }
  }

  /** Promotional broadcasts: the safeguards that must all be in place before any audience leaves LeadFlow. */
  private requireBroadcastReady(campaign: EmailCampaign, mailbox: EmailMailbox): void {
    if (!this.config.get('EMAIL_RESEND_BROADCASTS_ENABLED')) {
      throw AppException.validation(
        'Resend Broadcasts are not enabled on this LeadFlow server yet.',
      );
    }
    if (mailbox.apiKeyAccess !== 'full') {
      throw AppException.validation(
        'Broadcasts need a full-access API key for the dedicated Resend marketing account. Test Resend in Email settings.',
      );
    }
    if (!mailbox.domainVerifiedAt) {
      throw AppException.validation(
        'Promotional email needs a verified sending domain (DKIM and return path). Test Resend in Email settings.',
      );
    }
    if (!mailbox.encryptedWebhookSecret) {
      throw AppException.validation(
        'Promotional email needs the Resend webhook, so unsubscribes, bounces and complaints reach LeadFlow.',
      );
    }
    if (campaign.assetIds.length > 0) {
      throw AppException.validation(
        'Broadcasts cannot carry attachments. Link to the catalogue instead.',
      );
    }
    // One message for everyone: only fields Resend can fill per contact.
    const used = [...`${campaign.html} ${campaign.text}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map(
      (m) => m[1]!.toLowerCase(),
    );
    const unsupported = [...new Set(used)].filter(
      (f) => !(f in BROADCAST_MERGE_FIELDS) && f !== 'organization' && f !== 'sender_name',
    );
    if (unsupported.length > 0) {
      throw AppException.validation(
        `A broadcast can only personalise first name and last name. Remove: ${unsupported.map((f) => `{{${f}}}`).join(', ')}.`,
      );
    }
    if (/\{\{\s*(first_name|last_name|full_name)\s*\}\}/i.test(campaign.subject)) {
      throw AppException.validation('A broadcast subject cannot be personalised per recipient.');
    }
  }

  private requireCustomerSending(): void {
    if (!this.config.get('EMAIL_CAMPAIGNS_SENDING_ENABLED')) {
      throw AppException.validation(
        'Sending campaigns to customers is not enabled on this LeadFlow server yet. Drafts and previews work.',
      );
    }
  }

  /** Test emails are real sends: both email switches must be on (strictly true). */
  private requireTestSending(): void {
    if (
      this.config.get('EMAIL_DISPATCH_ENABLED') !== true ||
      this.config.get('EMAIL_CAMPAIGNS_SENDING_ENABLED') !== true
    ) {
      throw AppException.validation(
        'Test emails are switched off on this LeadFlow server: email sending has not been enabled yet. Drafts and previews work.',
      );
    }
  }

  private async buildAudience(
    filter: EmailRecipientFilter,
    purpose: 'PROMOTIONAL' | 'TRANSACTIONAL',
  ): Promise<AudienceResult> {
    const candidates = await this.audience.candidates(filter);
    if (candidates.length > MAX_AUDIENCE) {
      throw AppException.validation(
        `This filter matches more than ${MAX_AUDIENCE} people. Narrow it down.`,
      );
    }
    const emails = [
      ...new Set(
        candidates.map((c) => c.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e)),
      ),
    ];
    const [consents, suppressions] = await Promise.all([
      this.consents.consentsFor(emails),
      this.consents.suppressionsFor(emails),
    ]);
    const consented = new Set(
      [...consents.values()].filter((c) => c.status === 'GRANTED').map((c) => c.email),
    );
    return evaluateAudience(
      candidates,
      purpose,
      { consented, suppressed: new Set(suppressions.keys()) },
      await this.repository.organizationName(),
      new Set((filter.excludeEmails ?? []).map((e) => e.trim().toLowerCase())),
    );
  }

  private async require(id: string): Promise<EmailCampaign> {
    const campaign = await this.repository.find(id);
    if (!campaign) throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Campaign not found.');
    return campaign;
  }

  private async toView(campaign: EmailCampaign): Promise<EmailCampaignView> {
    const perStatus =
      (await this.repository.statusCounts([campaign.id])).get(campaign.id) ??
      new Map<EmailRecipientStatus, number>();
    const engagement = await this.repository.engagementCounts(campaign.id);
    const n = (status: EmailRecipientStatus) => perStatus.get(status) ?? 0;
    const counts: EmailCampaignCounts = {
      selected: campaign.selectedCount,
      eligible: campaign.eligibleCount,
      excluded: (campaign.excluded ?? {}) as EmailCampaignCounts['excluded'],
      queued: n('QUEUED'),
      sending: n('SENDING'),
      attempted: engagement.attempted,
      accepted: n('ACCEPTED'),
      retrying: engagement.retrying,
      failed: n('FAILED'),
      uncertain: n('UNCERTAIN'),
      cancelled: n('CANCELLED'),
      skipped: n('SKIPPED'),
      replies: engagement.replies,
      unsubscribes: engagement.unsubscribes,
    };
    return {
      id: campaign.id,
      name: campaign.name,
      category: campaign.category,
      purpose: campaign.purpose,
      status: campaign.status,
      subject: campaign.subject,
      html: campaign.html,
      text: campaign.text,
      assetIds: campaign.assetIds,
      filter: campaign.filter as EmailRecipientFilter,
      scheduledAt: iso(campaign.scheduledAt),
      confirmedAt: iso(campaign.confirmedAt),
      startedAt: iso(campaign.startedAt),
      pausedAt: iso(campaign.pausedAt),
      pauseReason: campaign.pauseReason,
      completedAt: iso(campaign.completedAt),
      cancelledAt: iso(campaign.cancelledAt),
      createdAt: campaign.createdAt.toISOString(),
      updatedAt: campaign.updatedAt.toISOString(),
      counts,
      broadcast:
        campaign.deliveryChannel === 'RESEND_BROADCAST' ? await this.broadcastView(campaign) : null,
    };
  }

  private async broadcastView(campaign: EmailCampaign): Promise<EmailBroadcastView> {
    const rows = await this.broadcastRows.reviews(campaign.id);
    const names = await this.repository.userNames(
      rows.map((r) => r.actorUserId).filter((v): v is string => v !== null),
    );
    const handed =
      campaign.broadcastState === 'HANDED_OFF' ||
      ['queued', 'scheduled', 'sent'].includes(campaign.broadcastProviderStatus ?? '');
    const exposure: EmailBroadcastExposure = handed
      ? 'HANDED_TO_RESEND'
      : campaign.broadcastSendRequestedAt
        ? 'MAY_HAVE_BEEN_SENT'
        : 'NOT_SENT';
    return {
      state: campaign.broadcastState,
      stateAt: iso(campaign.broadcastStateAt),
      version: campaign.broadcastVersion,
      error: campaign.broadcastError,
      providerBroadcastId: campaign.providerBroadcastId,
      sendRequestedAt: iso(campaign.broadcastSendRequestedAt),
      lastCheckedAt: iso(campaign.broadcastCheckedAt),
      lastProviderStatus: campaign.broadcastProviderStatus,
      exposure,
      needsReview: campaign.broadcastState === 'NEEDS_REVIEW' && campaign.status === 'PAUSED',
      reviews: rows.map(
        (r): EmailBroadcastReviewView => ({
          id: r.id,
          actorUserId: r.actorUserId,
          actorName: r.actorUserId ? (names.get(r.actorUserId) ?? null) : null,
          action: r.action as EmailBroadcastReviewView['action'],
          reason: r.reason,
          outcome: r.outcome as EmailBroadcastReviewView['outcome'],
          refusal: r.refusal,
          previousState: r.previousState,
          previousStatus: r.previousStatus as EmailBroadcastReviewView['previousStatus'],
          resultingState: r.resultingState,
          resultingStatus: r.resultingStatus as EmailBroadcastReviewView['resultingStatus'],
          providerStatus: r.providerStatus,
          recipientsClosed: r.recipientsClosed,
          createdAt: r.createdAt.toISOString(),
        }),
      ),
    };
  }
}

class ConfirmRaceError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Drops empty lists so a stored filter says only what was chosen. */
function cleanFilter(filter: EmailRecipientFilter): EmailRecipientFilter {
  const out: EmailRecipientFilter = {};
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (Array.isArray(value) && value.length > 0) (out as Record<string, unknown>)[key] = value;
    if (key === 'includeContacts' && value === true) out.includeContacts = true;
    if (key === 'source' && value === 'CUSTOM') out.source = 'CUSTOM';
  }
  return out;
}
