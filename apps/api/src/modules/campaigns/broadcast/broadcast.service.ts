import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../../common/config/config.module';
import { AppException } from '../../../common/errors/app.exception';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { EmailCampaign, EmailMailbox } from '../../../generated/prisma/client';
import { normalizeEmailAddress, renderEmail, type MergeValues } from '../content/email-content';
import { MailboxService } from '../mailbox/mailbox.service';
import { BroadcastRepository } from './broadcast.repository';
import {
  BROADCAST_MERGE_FIELDS,
  NO_REPORT_AFTER_MS,
  RESEND_UNSUBSCRIBE_PLACEHOLDER,
  RETRY_LIMIT_MS,
  type BroadcastState,
} from './broadcast-state';
import { ResendMarketingClient } from './resend-marketing.client';

/** A send request younger than this may still be switching the broadcast from draft. */
const SEND_SETTLE_MS = 2 * 60_000;

export interface BroadcastTickReport {
  advanced: number;
  handedOff: number;
  blocked: number;
  completed: number;
  needsReview: number;
}

type Verdict = { verdict: 'READY' | 'EMPTY' } | { verdict: 'BLOCKED' | 'RETRY'; reason: string };

export type ReviewAction = 'retry' | 'abandon';

export interface ReviewOutcome {
  /** What LeadFlow did, after reading the live broadcast status. */
  outcome: 'retrying' | 'abandoned' | 'already_handed_off' | 'cancelled_at_provider';
  providerStatus: string | null;
  recipientsClosed: number;
}

export interface CancelOutcome {
  providerStatusBefore: string;
  providerStatusAfter: string;
  recipientsClosed: number;
}

/**
 * Promotional campaigns through Resend Broadcasts, driven one persisted step at
 * a time (see broadcast-state.ts). LeadFlow stays the source of truth: who is
 * eligible is decided here, from LeadFlow's consent and suppression records,
 * immediately before the send — Resend's segment is made to match exactly, or
 * nothing is sent.
 */
@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly repository: BroadcastRepository,
    private readonly tenantContext: TenantContextService,
    private readonly mailbox: MailboxService,
    private readonly config: AppConfig,
  ) {}

  private enabled(): boolean {
    return (
      this.config.get('EMAIL_CAMPAIGNS_SENDING_ENABLED') &&
      this.config.get('EMAIL_RESEND_BROADCASTS_ENABLED')
    );
  }

  private client(mailbox: EmailMailbox): ResendMarketingClient {
    return new ResendMarketingClient(
      this.mailbox.resendApiKey(mailbox),
      this.mailbox.deps.fetchImpl,
      this.mailbox.deps.resendMinIntervalMs,
    );
  }

  /** Every organization's in-flight broadcasts, one step each. */
  async tick(now = new Date()): Promise<BroadcastTickReport> {
    const report: BroadcastTickReport = {
      advanced: 0,
      handedOff: 0,
      blocked: 0,
      completed: 0,
      needsReview: 0,
    };
    if (!this.enabled()) return report;
    for (const organizationId of await this.repository.organizationsWithBroadcasts()) {
      await this.tenantContext.runForOrganization(organizationId, 'email broadcasts', async () => {
        const mailbox = await this.repository.mailbox();
        for (const campaign of await this.repository.activeBroadcasts()) {
          if (
            !mailbox?.encryptedApiKey ||
            mailbox.sendingProvider !== 'RESEND' ||
            !mailbox.enabled
          ) {
            await this.repository.block(
              campaign.id,
              'Paused: the Resend account is not set up or is switched off in Email settings.',
            );
            report.blocked++;
            continue;
          }
          await this.advance(campaign, mailbox, now, report);
        }
      });
    }
    return report;
  }

  async advance(
    campaign: EmailCampaign,
    mailbox: EmailMailbox,
    now: Date,
    report: BroadcastTickReport,
  ): Promise<void> {
    const client = this.client(mailbox);
    const state = (campaign.broadcastState ?? 'PENDING') as BroadcastState;
    report.advanced++;
    switch (state) {
      case 'PENDING':
        return this.syncContacts(campaign, mailbox, client, report, now);
      case 'CONTACTS_SYNCED':
        return this.buildSegment(campaign, client, report, now);
      case 'SEGMENT_READY':
        return this.createDraft(campaign, mailbox, client, report, now);
      case 'DRAFT_CREATED':
        return this.requestSend(campaign, mailbox, client, report, now);
      case 'SEND_REQUESTED':
        return this.resolveSendRequest(campaign, client, report, now);
      case 'HANDED_OFF':
        return this.watch(campaign, report, now);
      default:
        return;
    }
  }

  /**
   * A step that could not complete. It is tried again on the next tick; once it
   * has failed for RETRY_LIMIT_MS the campaign waits for a person (NEEDS_REVIEW).
   */
  private async wait(
    campaign: EmailCampaign,
    message: string,
    report: BroadcastTickReport,
    now: Date,
  ): Promise<void> {
    const since = await this.repository.recordWaiting(campaign.id, message, now);
    if (now.getTime() - since.getTime() < RETRY_LIMIT_MS) return;
    const reason = `Needs review: ${message} This has not cleared for ${RETRY_LIMIT_MS / 60_000} minutes. Nothing more is sent until someone resolves it.`;
    if (await this.repository.needsReview(campaign.id, reason)) report.needsReview++;
  }

  // --- PENDING → CONTACTS_SYNCED ----------------------------------------------------

  private async syncContacts(
    campaign: EmailCampaign,
    mailbox: EmailMailbox,
    client: ResendMarketingClient,
    report: BroadcastTickReport,
    now: Date,
  ) {
    // Fail closed: nothing goes to Resend while it still lists someone LeadFlow has suppressed.
    if (!(await this.pushUnsubscribes(mailbox, client, now))) {
      return this.wait(campaign, 'An unsubscribe could not be sent to Resend yet.', report, now);
    }
    const eligible = await this.eligibleRecipients(campaign);
    const ledger = await this.repository.ledger(eligible.map((r) => r.email));
    for (const recipient of eligible) {
      const known = ledger.get(recipient.email);
      const contact = await client.getContact(recipient.email);
      const names = splitName(recipient.displayName, recipient.mergeData as MergeValues);
      if (contact.kind === 'ok') {
        if (contact.body.unsubscribed) {
          await this.repository.suppressUnsubscribed(recipient.email, campaign.id);
          await this.repository.recordUnsubscribed(mailbox.id, recipient.email, now, true);
          continue;
        }
        if (known?.unsubscribedAt) {
          // LeadFlow remembers an unsubscribe Resend no longer shows: LeadFlow wins.
          await this.repository.suppressUnsubscribed(recipient.email, campaign.id);
          continue;
        }
        await client.updateContactNames(recipient.email, names); // names only; failure is not a reason to stop
        await this.repository.recordSynced(mailbox.id, recipient.email, contact.body.id, now);
      } else if (contact.kind === 'http' && contact.status === 404) {
        if (known?.unsubscribedAt) {
          // Deleted at Resend after unsubscribing: never re-created as subscribed.
          await this.repository.suppressUnsubscribed(recipient.email, campaign.id);
          continue;
        }
        const created = await client.createContact({ email: recipient.email, ...names });
        if (created.kind !== 'ok') {
          return this.wait(
            campaign,
            `Could not add ${recipient.email} to Resend (${describe(created)}).`,
            report,
            now,
          );
        }
        await this.repository.recordSynced(mailbox.id, recipient.email, created.body.id, now);
      } else {
        // Unknown subscription state: fail closed, try again next tick.
        return this.wait(
          campaign,
          `Could not read ${recipient.email} at Resend (${describe(contact)}).`,
          report,
          now,
        );
      }
    }
    await this.repository.transition(campaign.id, 'PENDING', 'CONTACTS_SYNCED');
  }

  // --- CONTACTS_SYNCED → SEGMENT_READY ----------------------------------------------

  private async buildSegment(
    campaign: EmailCampaign,
    client: ResendMarketingClient,
    report: BroadcastTickReport,
    now: Date,
  ) {
    let segmentId = campaign.providerSegmentId;
    if (!segmentId) {
      const created = await client.createSegment(`LeadFlow campaign ${campaign.id}`);
      if (created.kind !== 'ok') {
        return this.wait(
          campaign,
          `Could not create the Resend segment (${describe(created)}).`,
          report,
          now,
        );
      }
      segmentId = created.body.id;
      // Stored before any contact is added, so a restart reuses this segment.
      if (
        !(await this.repository.transition(campaign.id, 'CONTACTS_SYNCED', 'CONTACTS_SYNCED', {
          providerSegmentId: segmentId,
        }))
      ) {
        return;
      }
    }
    for (const recipient of await this.repository.pendingRecipients(campaign.id)) {
      const added = await client.addToSegment(recipient.email, segmentId);
      if (added.kind !== 'ok') {
        return this.wait(
          campaign,
          `Could not add ${recipient.email} to the segment (${describe(added)}).`,
          report,
          now,
        );
      }
    }
    await this.repository.transition(campaign.id, 'CONTACTS_SYNCED', 'SEGMENT_READY');
  }

  // --- SEGMENT_READY → DRAFT_CREATED ------------------------------------------------

  private async createDraft(
    campaign: EmailCampaign,
    mailbox: EmailMailbox,
    client: ResendMarketingClient,
    report: BroadcastTickReport,
    now: Date,
  ) {
    const checked = await this.precheck(campaign, mailbox, client, now);
    if (checked.verdict !== 'READY') return this.settle(campaign, checked, report, now);
    const organizationName = await this.repository.organizationName();
    const content = broadcastContent(campaign, organizationName);
    const draft = await client.createDraftBroadcast({
      segmentId: campaign.providerSegmentId!,
      from: `${displayName(organizationName)} <${mailbox.fromAddress ?? mailbox.emailAddress}>`,
      replyTo: mailbox.emailAddress,
      subject: content.subject,
      html: content.html,
      text: content.text,
      name: `LeadFlow: ${campaign.name}`.slice(0, 200),
    });
    if (draft.kind !== 'ok') {
      // A draft that may have been created is harmless: drafts are never sent unless asked.
      return this.wait(
        campaign,
        `Could not create the Resend broadcast (${describe(draft)}).`,
        report,
        now,
      );
    }
    await this.repository.transition(campaign.id, 'SEGMENT_READY', 'DRAFT_CREATED', {
      providerBroadcastId: draft.body.id,
    });
  }

  // --- DRAFT_CREATED → SEND_REQUESTED → HANDED_OFF ----------------------------------

  private async requestSend(
    campaign: EmailCampaign,
    mailbox: EmailMailbox,
    client: ResendMarketingClient,
    report: BroadcastTickReport,
    now: Date,
  ) {
    // Immediately before sending: eligibility, consent, suppression and exact
    // segment membership, all checked again.
    const checked = await this.precheck(campaign, mailbox, client, now);
    if (checked.verdict !== 'READY') return this.settle(campaign, checked, report, now);
    // Persisted BEFORE the request: from here on the send is only ever resolved by reading.
    if (
      !(await this.repository.transition(campaign.id, 'DRAFT_CREATED', 'SEND_REQUESTED', {
        broadcastSendRequestedAt: now,
      }))
    ) {
      return;
    }
    const sent = await client.sendBroadcast(campaign.providerBroadcastId!);
    if (sent.kind === 'ok') {
      await this.handOff(campaign, report);
      return;
    }
    // Error or no answer: the request may or may not have taken effect. Stay in
    // SEND_REQUESTED; the next tick reads the status. Never asked again blindly.
    await this.repository.recordError(
      campaign.id,
      `Send requested; confirming with Resend (${describe(sent)}).`,
    );
  }

  /**
   * SEND_REQUESTED is resolved only by reading the broadcast. LeadFlow never
   * asks Resend to send it a second time on its own: a broadcast that still
   * reads `draft` after the settle period goes to a person (NEEDS_REVIEW).
   */
  private async resolveSendRequest(
    campaign: EmailCampaign,
    client: ResendMarketingClient,
    report: BroadcastTickReport,
    now: Date,
  ) {
    const status = await client.getBroadcast(campaign.providerBroadcastId!);
    if (status.kind !== 'ok') {
      return this.wait(
        campaign,
        `Could not read the broadcast status at Resend to confirm the send (${describe(status)}).`,
        report,
        now,
      );
    }
    switch (status.body.status) {
      case 'scheduled':
      case 'queued':
      case 'sent':
        await this.handOff(campaign, report);
        return;
      case 'canceled':
        await this.repository.transition(campaign.id, 'SEND_REQUESTED', 'CANCELLED_AT_PROVIDER');
        await this.repository.block(campaign.id, 'The broadcast was cancelled in Resend.');
        return;
      case 'draft': {
        const requestedAt = campaign.broadcastSendRequestedAt?.getTime() ?? 0;
        if (now.getTime() - requestedAt < SEND_SETTLE_MS) return;
        if (
          await this.repository.needsReview(
            campaign.id,
            'Needs review: Resend still shows this broadcast as a draft after the send was requested. It was probably not sent, but LeadFlow will not ask again on its own. Check the broadcast in Resend, then choose Send again or Abandon.',
          )
        ) {
          report.needsReview++;
        }
        return;
      }
      default:
        return this.wait(
          campaign,
          `Unexpected broadcast status from Resend: ${String(status.body.status)}.`,
          report,
          now,
        );
    }
  }

  private async handOff(campaign: EmailCampaign, report: BroadcastTickReport) {
    if (await this.repository.transition(campaign.id, 'SEND_REQUESTED', 'HANDED_OFF')) {
      await this.repository.markHandedOff(campaign.id);
      report.handedOff++;
    }
  }

  // --- HANDED_OFF → COMPLETED -------------------------------------------------------

  private async watch(campaign: EmailCampaign, report: BroadcastTickReport, now: Date) {
    if ((await this.repository.openRecipients(campaign.id)) === 0) {
      await this.repository.complete(campaign.id, now);
      report.completed++;
      return;
    }
    if (
      now.getTime() - (campaign.broadcastStateAt?.getTime() ?? now.getTime()) >
      NO_REPORT_AFTER_MS
    ) {
      await this.repository.closeUnreported(campaign.id);
      await this.repository.complete(campaign.id, now);
      report.completed++;
    }
  }

  // --- a person's decisions -------------------------------------------------------

  /**
   * Resolves a campaign in NEEDS_REVIEW. The live broadcast status is read
   * first and always wins: a broadcast Resend has queued or sent is recorded as
   * handed off whatever was asked. `retry` sends only from a confirmed draft,
   * and then through the normal path (precheck, one send request).
   */
  async resolveReview(campaign: EmailCampaign, action: ReviewAction): Promise<ReviewOutcome> {
    if (campaign.broadcastState !== 'NEEDS_REVIEW' || campaign.status !== 'PAUSED') {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        'This broadcast is not waiting for review.',
      );
    }
    const mailbox = await this.repository.mailbox();
    const sendRequested = campaign.broadcastSendRequestedAt !== null;
    let providerStatus: string | null = null;
    if (campaign.providerBroadcastId) {
      if (!mailbox?.encryptedApiKey) {
        throw AppException.validation('The Resend account is not set up in Email settings.');
      }
      const status = await this.client(mailbox).getBroadcast(campaign.providerBroadcastId);
      if (status.kind === 'ok') {
        providerStatus = status.body.status;
      } else if (action === 'retry') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          `Resend's status for this broadcast cannot be read right now (${describe(status)}). Nothing was changed; try again.`,
        );
      }
    }

    if (
      providerStatus === 'scheduled' ||
      providerStatus === 'queued' ||
      providerStatus === 'sent'
    ) {
      if (!(await this.repository.leaveReview(campaign.id, 'HANDED_OFF'))) throw raced();
      await this.repository.markHandedOff(campaign.id);
      return { outcome: 'already_handed_off', providerStatus, recipientsClosed: 0 };
    }
    if (providerStatus === 'canceled') {
      const closed = await this.repository.endBroadcast(
        campaign.id,
        ['PAUSED'],
        'CANCELLED_AT_PROVIDER',
        sendRequested,
        'The broadcast was cancelled in Resend. Emails Resend had already sent cannot be recalled; delivery reports update this row.',
      );
      if (closed === null) throw raced();
      return { outcome: 'cancelled_at_provider', providerStatus, recipientsClosed: closed };
    }

    if (action === 'retry') {
      // A confirmed draft (or no broadcast yet): back through the normal steps,
      // which re-run the precheck and request the send exactly once.
      const to: BroadcastState = campaign.providerBroadcastId ? 'DRAFT_CREATED' : 'PENDING';
      if (!(await this.repository.leaveReview(campaign.id, to))) throw raced();
      return { outcome: 'retrying', providerStatus, recipientsClosed: 0 };
    }

    // Abandon. Unread status after a send request: the recipients may have mail.
    const maybeSent = sendRequested && providerStatus === null;
    const closed = await this.repository.endBroadcast(
      campaign.id,
      ['PAUSED'],
      'NEEDS_REVIEW',
      maybeSent,
      maybeSent
        ? "Abandoned while Resend's status could not be read: this address may have received the email. A delivery report would update this row."
        : 'Abandoned after review; Resend had not sent the broadcast.',
    );
    if (closed === null) throw raced();
    return { outcome: 'abandoned', providerStatus, recipientsClosed: closed };
  }

  /**
   * Cancel after the send was requested. Resend can cancel a queued or
   * scheduled broadcast (POST /broadcasts/{id}/cancel); that stops only emails
   * not yet sent. A sent broadcast cannot be recalled and is refused.
   */
  async cancelAtProvider(campaign: EmailCampaign, now = new Date()): Promise<CancelOutcome> {
    const mailbox = await this.repository.mailbox();
    if (!mailbox?.encryptedApiKey || !campaign.providerBroadcastId) {
      throw AppException.validation('The Resend account is not set up in Email settings.');
    }
    const client = this.client(mailbox);
    const before = await client.getBroadcast(campaign.providerBroadcastId);
    if (before.kind !== 'ok') {
      throw AppException.conflict(
        ERROR_CODES.CONFLICT,
        `Resend's status for this broadcast cannot be read right now (${describe(before)}). Nothing was changed; try again.`,
      );
    }
    const statusBefore = before.body.status;
    if (statusBefore === 'sent') throw alreadySent();

    let statusAfter: string = statusBefore;
    if (statusBefore === 'queued' || statusBefore === 'scheduled') {
      const cancelled = await client.cancelBroadcast(campaign.providerBroadcastId);
      // Whatever the answer, the read decides.
      const after = await client.getBroadcast(campaign.providerBroadcastId);
      if (after.kind !== 'ok') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          `Resend did not confirm the cancellation (${describe(cancelled)}; status unreadable). LeadFlow changed nothing; check the broadcast in Resend.`,
        );
      }
      statusAfter = after.body.status;
      if (statusAfter === 'sent') throw alreadySent();
      if (statusAfter !== 'canceled' && statusAfter !== 'draft') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          `Resend did not cancel the broadcast (status: ${statusAfter}; ${describe(cancelled)}). LeadFlow changed nothing.`,
        );
      }
    } else if (statusBefore === 'draft') {
      const requestedAt = campaign.broadcastSendRequestedAt?.getTime() ?? 0;
      if (now.getTime() - requestedAt < SEND_SETTLE_MS) {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'The send request is still settling at Resend. Try again in two minutes.',
        );
      }
    }

    // Queued at Resend: some emails may already have gone. A late send report
    // for a cancelled draft is possible too. Both stay UNCERTAIN until reported.
    const maybeSent = statusBefore === 'queued' || statusBefore === 'draft';
    const closed = await this.repository.endBroadcast(
      campaign.id,
      ['SENDING', 'PAUSED'],
      statusBefore === 'draft'
        ? (campaign.broadcastState as BroadcastState)
        : 'CANCELLED_AT_PROVIDER',
      maybeSent,
      statusBefore === 'queued'
        ? 'Cancelled at Resend while queued. Emails Resend had already sent cannot be recalled; a delivery report updates this row.'
        : 'Cancelled before Resend sent the broadcast; a delivery report would update this row.',
    );
    if (closed === null) throw raced();
    return {
      providerStatusBefore: statusBefore,
      providerStatusAfter: statusAfter,
      recipientsClosed: closed,
    };
  }

  // --- the precheck -------------------------------------------------------------------

  /**
   * Makes Resend's segment exactly the set LeadFlow says may receive this
   * campaign NOW, or refuses.
   *
   * Membership is verified contact by contact (GET /contacts/{email}/segments),
   * because Resend documents no consistency or ordering guarantee for the
   * segment listing. The listing is used only to find strangers. Any correction
   * means "check again next tick", never "send now": a send happens only after
   * a pass that found nothing to fix. A mismatch that persists becomes
   * NEEDS_REVIEW (see wait()).
   */
  private async precheck(
    campaign: EmailCampaign,
    mailbox: EmailMailbox,
    client: ResendMarketingClient,
    now: Date,
  ): Promise<Verdict> {
    if (!(await this.pushUnsubscribes(mailbox, client, now))) {
      return { verdict: 'RETRY', reason: 'An unsubscribe could not be sent to Resend yet.' };
    }
    const segmentId = campaign.providerSegmentId!;
    const eligible = await this.eligibleRecipients(campaign);
    const ledger = await this.repository.ledger(eligible.map((r) => r.email));
    const expected = new Set<string>();
    for (const recipient of eligible) {
      if (ledger.get(recipient.email)?.unsubscribedAt) {
        await this.repository.suppressUnsubscribed(recipient.email, campaign.id);
        continue;
      }
      const contact = await client.getContact(recipient.email);
      if (contact.kind !== 'ok') {
        // Unknown state: never send on a guess.
        return {
          verdict: 'RETRY',
          reason: `Could not read ${recipient.email} at Resend (${describe(contact)}).`,
        };
      }
      if (contact.body.unsubscribed) {
        await this.repository.suppressUnsubscribed(recipient.email, campaign.id);
        await this.repository.recordUnsubscribed(mailbox.id, recipient.email, now, true);
        continue;
      }
      expected.add(recipient.email);
    }

    let corrected = 0;
    // Everyone LeadFlow may have added (the whole campaign), checked one by one.
    for (const email of await this.repository.campaignEmails(campaign.id)) {
      const segments = await client.contactSegments(email);
      if (segments.kind !== 'ok') {
        if (!expected.has(email) && segments.kind === 'http' && segments.status === 404) continue;
        return {
          verdict: 'RETRY',
          reason: `Could not verify the segment membership of ${email} (${describe(segments)}).`,
        };
      }
      const member = segments.body.includes(segmentId);
      if (expected.has(email) && !member) {
        const added = await client.addToSegment(email, segmentId);
        if (added.kind !== 'ok') {
          return {
            verdict: 'RETRY',
            reason: `Could not add ${email} to the segment (${describe(added)}).`,
          };
        }
        corrected++;
      } else if (!expected.has(email) && member) {
        const removed = await this.removeFromSegment(client, email, segmentId);
        if (removed) return { verdict: 'RETRY', reason: removed };
        corrected++;
      }
    }
    // Anyone else the segment lists (de-duplicated across pages).
    const members = await client.listSegment(segmentId);
    if (members.kind !== 'ok') {
      return {
        verdict: 'RETRY',
        reason: `Could not list the Resend segment (${describe(members)}).`,
      };
    }
    const listed = new Set(members.body.map((c) => c.email.toLowerCase()));
    for (const email of [...listed].filter((e) => !expected.has(e))) {
      const removed = await this.removeFromSegment(client, email, segmentId);
      if (removed) return { verdict: 'RETRY', reason: removed };
      corrected++;
    }
    if (corrected > 0) {
      return {
        verdict: 'RETRY',
        reason: `The Resend segment was corrected (${corrected} change${corrected === 1 ? '' : 's'}); it is verified again before anything is sent.`,
      };
    }
    return { verdict: expected.size === 0 ? 'EMPTY' : 'READY' };
  }

  /** DELETE /contacts/{email}/segments/{id}. Null when done (or not a member); else why not. */
  private async removeFromSegment(
    client: ResendMarketingClient,
    email: string,
    segmentId: string,
  ): Promise<string | null> {
    const removed = await client.removeFromSegment(email, segmentId);
    if (removed.kind === 'ok' || (removed.kind === 'http' && removed.status === 404)) return null;
    return `Could not remove ${email} from the Resend segment (${describe(removed)}), so the audience cannot be guaranteed.`;
  }

  private async settle(
    campaign: EmailCampaign,
    checked: Exclude<Verdict, { verdict: 'READY' }>,
    report: BroadcastTickReport,
    now: Date,
  ) {
    if (checked.verdict === 'RETRY') return this.wait(campaign, checked.reason, report, now);
    if (checked.verdict === 'BLOCKED') {
      await this.repository.block(campaign.id, checked.reason);
      report.blocked++;
      return;
    }
    await this.repository.complete(campaign.id, now);
    report.completed++;
  }

  /** QUEUED recipients still eligible by LeadFlow's own records; the rest are skipped now. */
  private async eligibleRecipients(campaign: EmailCampaign) {
    const recipients = await this.repository.pendingRecipients(campaign.id);
    const facts = await this.repository.eligibility(recipients.map((r) => r.email));
    const skip = new Map<string, string[]>();
    const keep: typeof recipients = [];
    for (const r of recipients) {
      const reason = !normalizeEmailAddress(r.email)
        ? 'INVALID'
        : facts.suppressed.has(r.email)
          ? 'SUPPRESSED'
          : !facts.consented.has(r.email)
            ? 'NO_CONSENT'
            : null;
      if (reason) skip.set(reason, [...(skip.get(reason) ?? []), r.id]);
      else keep.push(r);
    }
    for (const [reason, ids] of skip) await this.repository.skip(ids, reason);
    return keep;
  }

  // --- unsubscribe synchronisation ------------------------------------------------------

  /** Tells Resend about every LeadFlow suppression it still lists as subscribed. False if any push failed. */
  async pushUnsubscribes(
    mailbox: EmailMailbox,
    client: ResendMarketingClient,
    now: Date,
  ): Promise<boolean> {
    for (const email of await this.repository.outstandingUnsubscribes()) {
      const pushed = await client.unsubscribeContact(email);
      if (pushed.kind === 'ok' || (pushed.kind === 'http' && pushed.status === 404)) {
        await this.repository.recordUnsubscribed(mailbox.id, email, now, true);
      } else {
        await this.repository.recordUnsubscribed(mailbox.id, email, now, false);
        return false;
      }
    }
    return true;
  }

  /** Both directions, every organization using Resend: push LeadFlow's, pull Resend's. */
  async reconcile(now = new Date()): Promise<{ pushedOk: boolean; pulled: number }> {
    let pushedOk = true;
    let pulled = 0;
    for (const organizationId of await this.repository.organizationsUsingResend()) {
      await this.tenantContext.runForOrganization(
        organizationId,
        'resend unsubscribe reconciliation',
        async () => {
          const mailbox = await this.repository.mailbox();
          if (!mailbox?.encryptedApiKey || mailbox.apiKeyAccess !== 'full') return;
          const client = this.client(mailbox);
          pushedOk = (await this.pushUnsubscribes(mailbox, client, now)) && pushedOk;
          const unsubscribed = await client.listUnsubscribed();
          if (unsubscribed.kind !== 'ok') return;
          for (const email of unsubscribed.body) {
            await this.repository.suppressUnsubscribed(email, null);
            await this.repository.recordUnsubscribed(mailbox.id, email, now, true);
            pulled++;
          }
        },
      );
    }
    return { pushedOk, pulled };
  }
}

function describe(result: { kind: string; status?: number; error?: string }): string {
  return result.kind === 'network' ? 'no answer' : (result.error ?? String(result.status));
}

function displayName(name: string): string {
  return (
    name
      .replace(/[\r\n"<>,;:@\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'LeadFlow'
  );
}

function splitName(
  displayNameValue: string | null,
  merge: MergeValues,
): { firstName: string | null; lastName: string | null } {
  const first = merge.first_name ?? displayNameValue?.split(' ')[0] ?? null;
  const last = merge.last_name ?? null;
  return { firstName: first?.slice(0, 80) ?? null, lastName: last?.slice(0, 80) ?? null };
}

/**
 * One message for the whole segment: LeadFlow's merge fields become Resend's
 * contact placeholders, and the footer's unsubscribe link is Resend's own.
 */
export function broadcastContent(
  campaign: Pick<EmailCampaign, 'subject' | 'html' | 'text' | 'purpose'>,
  organizationName: string,
): { subject: string; html: string; text: string } {
  const values: MergeValues = {
    ...BROADCAST_MERGE_FIELDS,
    organization: organizationName,
    sender_name: organizationName,
  };
  const rendered = renderEmail({
    subject: campaign.subject,
    html: campaign.html,
    text: campaign.text,
    values,
    footer: {
      organizationName,
      senderAddress: '',
      purpose: campaign.purpose,
      unsubscribeUrl: RESEND_UNSUBSCRIBE_PLACEHOLDER,
    },
  });
  return rendered;
}

function raced(): AppException {
  return AppException.conflict(
    ERROR_CODES.CONFLICT,
    'This broadcast changed while the request was being handled. Reload and try again.',
  );
}

function alreadySent(): AppException {
  return AppException.conflict(
    ERROR_CODES.CONFLICT,
    'Resend has already sent this broadcast. Sent emails cannot be recalled; delivery reports keep arriving in LeadFlow.',
  );
}
