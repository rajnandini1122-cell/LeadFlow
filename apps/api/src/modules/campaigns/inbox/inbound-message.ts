import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

/**
 * What LeadFlow takes from an incoming message — and what it deliberately does
 * not.
 *
 * Inbound mail is untrusted input from anyone on the internet. It is parsed by
 * a hardened MIME parser, and only facts are kept: ids for matching, the
 * sender, the subject and a short PLAIN-TEXT snippet. HTML is never rendered,
 * stored or interpreted; attachments are counted, never stored or opened; and
 * nothing in the content is ever treated as an instruction.
 */

/** The most of a message LeadFlow reads. Larger messages are cut off here. */
export const MAX_INBOUND_BYTES = 256 * 1024;
const SNIPPET_CHARS = 600;

export interface InboundFacts {
  messageId: string | null;
  inReplyTo: string | null;
  /** Message-IDs this message refers to, most specific first: In-Reply-To, then References (newest first). */
  referencedIds: string[];
  fromAddress: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: Date | null;
  attachmentCount: number;
  /** For a delivery status notification: which of our messages bounced, and the status. */
  bounce: { originalMessageIds: string[]; status: string | null; diagnostic: string | null } | null;
  autoReply: boolean;
}

const MESSAGE_ID = /<[^<>\s]{1,250}>/g;

function ids(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(' ') : (value ?? '');
  return [...raw.matchAll(MESSAGE_ID)].map((m) => m[0]);
}

function firstAddress(value: AddressObject | AddressObject[] | undefined): string | null {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  for (const group of list) {
    for (const entry of group.value) {
      if (entry.address) return entry.address.trim().toLowerCase().slice(0, 320);
    }
  }
  return null;
}

/** The new text of a reply: quoted history ("> …", "On … wrote:") is dropped. */
export function replySnippet(text: string): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .{4,200} wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: /i.test(line.trim()) && lines.length > 0) break;
    lines.push(line);
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, SNIPPET_CHARS);
}

function deliveryStatus(parsed: ParsedMail): InboundFacts['bounce'] {
  const contentType = String(
    parsed.headers.get('content-type')
      ? ((parsed.headers.get('content-type') as { value?: string; params?: Record<string, string> })
          .value ?? '')
      : '',
  );
  const params =
    (parsed.headers.get('content-type') as { params?: Record<string, string> } | undefined)
      ?.params ?? {};
  const isReport =
    /multipart\/report/i.test(contentType) && /delivery-status/i.test(params['report-type'] ?? '');
  const subject = parsed.subject ?? '';
  const looksLikeBounce =
    isReport ||
    /^(undeliver|returned mail|delivery status notification|mail delivery (failed|system))/i.test(
      subject,
    );
  if (!looksLikeBounce) return null;

  // The original message (or its headers) travels as an attachment or in the text.
  const sources: string[] = [parsed.text ?? ''];
  for (const attachment of parsed.attachments ?? []) {
    if (/message\/(rfc822|delivery-status)|text\/rfc822-headers/i.test(attachment.contentType)) {
      sources.push(attachment.content.toString('utf8').slice(0, 64 * 1024));
    }
  }
  const joined = sources.join('\n');
  const originalMessageIds = [
    ...new Set(
      [
        ...joined.matchAll(
          /^(?:Message-ID|Original-Message-ID|X-Original-Message-ID):\s*(<[^<>\s]{1,250}>)/gim,
        ),
      ].map((m) => m[1]!),
    ),
  ];
  const status = /^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(joined)?.[1] ?? null;
  const diagnostic = /^Diagnostic-Code:\s*(.{1,300})$/im.exec(joined)?.[1]?.trim() ?? null;
  return { originalMessageIds, status, diagnostic };
}

export async function parseInbound(source: Buffer): Promise<InboundFacts> {
  const parsed = await simpleParser(source.subarray(0, MAX_INBOUND_BYTES), {
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
    keepCidLinks: false,
  });
  const inReplyTo = ids(parsed.inReplyTo)[0] ?? null;
  const references = ids(parsed.references).reverse();
  const autoSubmitted = String(parsed.headers.get('auto-submitted') ?? '').toLowerCase();
  return {
    messageId: ids(parsed.messageId)[0] ?? null,
    inReplyTo,
    referencedIds: [...new Set([...(inReplyTo ? [inReplyTo] : []), ...references])],
    fromAddress: firstAddress(parsed.from),
    subject: parsed.subject ? parsed.subject.replace(/[\r\n]+/g, ' ').slice(0, 500) : null,
    snippet: parsed.text ? replySnippet(parsed.text) || null : null,
    receivedAt: parsed.date ?? null,
    attachmentCount: (parsed.attachments ?? []).filter((a) => a.contentDisposition === 'attachment')
      .length,
    bounce: deliveryStatus(parsed),
    autoReply:
      (autoSubmitted !== '' && autoSubmitted !== 'no') ||
      /^(auto|automatic reply|out of office)/i.test(parsed.subject ?? ''),
  };
}
