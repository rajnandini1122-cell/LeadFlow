import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../common/config/config.module';
import { TenantContextService } from '../../../common/tenancy/tenant-context.service';
import type { EmailCampaign, EmailMailbox } from '../../../generated/prisma/client';
import { normalizeEmailAddress, renderEmail, type MergeValues } from '../content/email-content';
import { MailboxService } from '../mailbox/mailbox.service';
import { BroadcastRepository } from './broadcast.repository';
import {
  BROADCAST_MERGE_FIELDS,
  NO_REPORT_AFTER_MS,
  RESEND_UNSUBSCRIBE_PLACEHOLDER,
  type BroadcastState,
} from './broadcast-state';
import { ResendMarketingClient } from './resend-marketing.client';

/** Do not read-and-resend a send request younger than this: Resend may still be switching it from draft. */
const SEND_SETTLE_MS = 2 * 60_000;

export interface BroadcastTickReport {
  advanced: number;
  handedOff: number;
  blocked: number;
  completed: number;
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
    );
  }

  /** Every organization's in-flight broadcasts, one step each. */
  async tick(now = new Date()): Promise<BroadcastTickReport> {
    const report: BroadcastTickReport = { advanced: 0, handedOff: 0, blocked: 0, completed: 0 };
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
        return this.syncContacts(campaign, mailbox, client, now);
      case 'CONTACTS_SYNCED':
        return this.buildSegment(campaign, client);
      case 'SEGMENT_READY':
        return this.createDraft(campaign, mailbox, client, report, now);
      case 'DRAFT_CREATED':
        return this.requestSend(campaign, mailbox, client, report, now);
      case 'SEND_REQUESTED':
        return this.resolveSendRequest(campaign, mailbox, client, report, now);
      case 'HANDED_OFF':
        return this.watch(campaign, report, now);
      default:
        return;
    }
  }

  // --- PENDING → CONTACTS_SYNCED ----------------------------------------------------

  private async syncContacts(
    campaign: EmailCampaign,
    mailbox: EmailMailbox,
    client: ResendMarketingClient,
    now: Date,
  ) {
    // Fail closed: nothing goes to Resend while it still lists someone LeadFlow has suppressed.
    if (!(await this.pushUnsubscribes(mailbox, client, now))) {
      await this.repository.recordError(
        campaign.id,
        'Waiting: an unsubscribe could not be sent to Resend yet.',
      );
      return;
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
          await this.repository.recordError(
            campaign.id,
            `Could not add ${recipient.email} to Resend (${describe(created)}).`,
          );
          return;
        }
        await this.repository.recordSynced(mailbox.id, recipient.email, created.body.id, now);
      } else {
        // Unknown subscription state: fail closed, try again next tick.
        await this.repository.recordError(
          campaign.id,
          `Could not read ${recipient.email} at Resend (${describe(contact)}).`,
        );
        return;
      }
    }
    await this.repository.transition(campaign.id, 'PENDING', 'CONTACTS_SYNCED');
  }

  // --- CONTACTS_SYNCED → SEGMENT_READY ----------------------------------------------

  private async buildSegment(campaign: EmailCampaign, client: ResendMarketingClient) {
    let segmentId = campaign.providerSegmentId;
    if (!segmentId) {
      const created = await client.createSegment(`LeadFlow campaign ${campaign.id}`);
      if (created.kind !== 'ok') {
        await this.repository.recordError(
          campaign.id,
          `Could not create the Resend segment (${describe(created)}).`,
        );
        return;
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
        await this.repository.recordError(
          campaign.id,
          `Could not add ${recipient.email} to the segment (${describe(added)}).`,
        );
        return;
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
    const verdict = await this.precheck(campaign, mailbox, client, now);
    if (verdict !== 'READY') return this.settle(campaign, verdict, report, now);
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
      await this.repository.recordError(
        campaign.id,
        `Could not create the Resend broadcast (${describe(draft)}).`,
      );
      return;
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
    const verdict = await this.precheck(campaign, mailbox, client, now);
    if (verdict !== 'READY') return this.settle(campaign, verdict, report, now);
    // Persisted BEFORE the request: from here on the send is only ever resolved by reading.
    if (
      !(await this.repository.transition(campaign.id, 'DRAFT_CREATED', 'SEND_REQUESTED', {
        broadcastSendRequestedAt: now,
      }))
    ) {
      return;
    }
    await this.send(campaign, client, report);
  }

  private async resolveSendRequest(
    campaign: EmailCampaign,
    mailbox: EmailMailbox,
    client: ResendMarketingClient,
    report: BroadcastTickReport,
    now: Date,
  ) {
    const status = await client.getBroadcast(campaign.providerBroadcastId!);
    if (status.kind !== 'ok') {
      await this.repository.recordError(
        campaign.id,
        `Waiting to confirm the send with Resend (${describe(status)}).`,
      );
      return;
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
        // Resend still has it as a draft: the earlier request did not send it.
        // Give an in-flight request time to land before asking again.
        const requestedAt = campaign.broadcastSendRequestedAt?.getTime() ?? 0;
        if (now.getTime() - requestedAt < SEND_SETTLE_MS) return;
        const verdict = await this.precheck(campaign, mailbox, client, now);
        if (verdict !== 'READY') return this.settle(campaign, verdict, report, now);
        await this.repository.transition(campaign.id, 'SEND_REQUESTED', 'SEND_REQUESTED', {
          broadcastSendRequestedAt: now,
        });
        await this.send(campaign, client, report);
        return;
      }
      default:
        await this.repository.recordError(
          campaign.id,
          `Unexpected broadcast status from Resend: ${String(status.body.status)}`,
        );
    }
  }

  private async send(
    campaign: EmailCampaign,
    client: ResendMarketingClient,
    report: BroadcastTickReport,
  ) {
    const sent = await client.sendBroadcast(campaign.providerBroadcastId!);
    if (sent.kind === 'ok') {
      await this.handOff(campaign, report);
      return;
    }
    // Error or no answer: stay in SEND_REQUESTED; the next tick reads the status.
    await this.repository.recordError(
      campaign.id,
      `Send requested; confirming with Resend (${describe(sent)}).`,
    );
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

  // --- the precheck -------------------------------------------------------------------

  /**
   * Makes Resend's segment exactly the set LeadFlow says may receive this
   * campaign NOW, or refuses. Returns READY, EMPTY (nobody left) or BLOCKED.
   */
  private async precheck(
    campaign: EmailCampaign,
    mailbox: EmailMailbox,
    client: ResendMarketingClient,
    now: Date,
  ): Promise<'READY' | 'EMPTY' | 'BLOCKED' | 'RETRY'> {
    if (!(await this.pushUnsubscribes(mailbox, client, now))) return 'RETRY';
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
      if (contact.kind !== 'ok') return 'RETRY'; // unknown state: never send on a guess
      if (contact.body.unsubscribed) {
        await this.repository.suppressUnsubscribed(recipient.email, campaign.id);
        await this.repository.recordUnsubscribed(mailbox.id, recipient.email, now, true);
        continue;
      }
      expected.add(recipient.email);
    }

    for (let pass = 0; pass < 2; pass++) {
      const members = await client.listSegment(segmentId);
      if (members.kind !== 'ok') return 'RETRY';
      const actual = new Set(members.body.map((c) => c.email.toLowerCase()));
      const extra = [...actual].filter((e) => !expected.has(e));
      const missing = [...expected].filter((e) => !actual.has(e));
      if (extra.length === 0 && missing.length === 0)
        return expected.size === 0 ? 'EMPTY' : 'READY';
      if (pass === 1) break;
      for (const email of extra) {
        const removed = await client.removeFromSegment(email, segmentId);
        if (removed.kind !== 'ok') {
          await this.repository.block(
            campaign.id,
            `Paused: ${email} could not be removed from the Resend segment, so the audience cannot be guaranteed.`,
          );
          return 'BLOCKED';
        }
      }
      for (const email of missing) {
        const added = await client.addToSegment(email, segmentId);
        if (added.kind !== 'ok') return 'RETRY';
      }
    }
    await this.repository.block(
      campaign.id,
      'Paused: the Resend segment does not match the eligible recipients.',
    );
    return 'BLOCKED';
  }

  private async settle(
    campaign: EmailCampaign,
    verdict: 'EMPTY' | 'BLOCKED' | 'RETRY',
    report: BroadcastTickReport,
    now: Date,
  ) {
    if (verdict === 'BLOCKED') report.blocked++;
    if (verdict === 'RETRY')
      await this.repository.recordError(
        campaign.id,
        'Waiting: Resend could not confirm the audience; nothing was sent.',
      );
    if (verdict === 'EMPTY') {
      await this.repository.complete(campaign.id, now);
      report.completed++;
    }
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
