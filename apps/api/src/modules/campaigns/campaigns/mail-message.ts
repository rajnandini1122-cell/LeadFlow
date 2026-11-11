import { randomUUID } from 'node:crypto';
import type { SendMailOptions } from 'nodemailer';
import { renderEmail, type MergeValues, type RenderedEmail } from '../content/email-content';
import { unsubscribeOneClickUrl, unsubscribePageUrl } from '../consent/unsubscribe-token';

export interface MessageAttachment {
  fileName: string;
  mimeType: string;
  data: Uint8Array;
}

export interface CampaignMessageInput {
  campaign: {
    id: string;
    purpose: 'PROMOTIONAL' | 'TRANSACTIONAL';
    subject: string;
    html: string;
    text: string;
  };
  organizationName: string;
  /** Where replies go: the mailbox LeadFlow reads over IMAP. */
  mailboxAddress: string;
  /** The From address, when campaigns send from a verified sending domain. Defaults to the mailbox. */
  fromAddress?: string | null;
  recipient: {
    email: string;
    displayName: string | null;
    messageId: string;
    unsubscribeToken: string | null;
  };
  merge: MergeValues;
  attachments: MessageAttachment[];
  webBaseUrl: string;
}

/** Our Message-ID for a new recipient: random, under the sender's own domain. */
export function newMessageId(mailboxAddress: string): string {
  const domain = mailboxAddress.split('@')[1] ?? 'leadflow.invalid';
  return `<${randomUUID()}.lf@${domain}>`;
}

/** A display name that cannot carry a header break or an address of its own. */
function displayName(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\r\n"<>,;:@\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function buildCampaignMessage(input: CampaignMessageInput): {
  options: SendMailOptions;
  rendered: RenderedEmail;
} {
  const promotional = input.campaign.purpose === 'PROMOTIONAL';
  const token = input.recipient.unsubscribeToken;
  const pageUrl = promotional && token ? unsubscribePageUrl(input.webBaseUrl, token) : null;

  const rendered = renderEmail({
    subject: input.campaign.subject,
    html: input.campaign.html,
    text: input.campaign.text,
    values: { ...input.merge, sender_name: input.organizationName },
    footer: {
      organizationName: input.organizationName,
      senderAddress: input.mailboxAddress,
      purpose: input.campaign.purpose,
      unsubscribeUrl: pageUrl,
    },
  });

  const headers: Record<string, string> = { 'X-LeadFlow-Campaign': input.campaign.id };
  if (promotional && token) {
    // RFC 2369 + RFC 8058: one-click unsubscribe from the mail client itself.
    headers['List-Unsubscribe'] = `<${unsubscribeOneClickUrl(input.webBaseUrl, token)}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    headers['Precedence'] = 'bulk';
  }

  const options: SendMailOptions = {
    from: {
      name: displayName(input.organizationName),
      address: input.fromAddress ?? input.mailboxAddress,
    },
    to: { name: displayName(input.recipient.displayName), address: input.recipient.email },
    // Replies come back to the mailbox LeadFlow reads.
    replyTo: input.mailboxAddress,
    // The envelope is stated, never derived from headers: exactly one recipient.
    envelope: { from: input.fromAddress ?? input.mailboxAddress, to: [input.recipient.email] },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    messageId: input.recipient.messageId,
    headers,
    attachments: input.attachments.map((a) => ({
      filename: a.fileName,
      content: Buffer.from(a.data),
      contentType: a.mimeType,
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  return { options, rendered };
}
