import { resolveMx as dnsResolveMx, resolveTxt as dnsResolveTxt } from 'node:dns/promises';
import type { SmtpOutcome } from './mail-connection';

/**
 * Campaign delivery through Resend's HTTPS API.
 *
 * Why it is safe to retry here when it is not over SMTP: every request carries
 * an Idempotency-Key (the recipient row's id). Resend keeps keys for 24 hours
 * and answers a repeat with the original response WITHOUT sending again. So a
 * timeout or a 5xx — "we don't know whether it was sent" — is retried, and the
 * provider, not luck, guarantees there is one message. Retries are confined to
 * well inside that window (backoff totals 81 minutes).
 */

export const RESEND_API = 'https://api.resend.com';
const REQUEST_TIMEOUT_MS = 20_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ResendEmail {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  attachments: { filename: string; content: string; contentType: string }[];
  tags: { name: string; value: string }[];
  idempotencyKey: string;
}

export type ResendOutcome = SmtpOutcome & { providerMessageId?: string };

/** Never contains the key: built from the status and Resend's error name/message only. */
function describe(status: number, body: { name?: string; message?: string }): string {
  return `Resend ${status}${body.name ? ` ${body.name}` : ''}${body.message ? `: ${body.message}` : ''}`.slice(
    0,
    500,
  );
}

export function classifyResendResponse(
  status: number,
  body: { id?: string; name?: string; message?: string },
): ResendOutcome {
  const response = describe(status, body);
  if (status >= 200 && status < 300 && body.id) {
    return {
      kind: 'ACCEPTED',
      code: status,
      response: `Accepted by Resend (${body.id})`,
      providerMessageId: body.id,
    };
  }
  if (status === 401 || status === 403) return { kind: 'MAILBOX', code: status, response };
  if (status === 409 && body.name === 'concurrent_idempotent_requests')
    return { kind: 'RETRY', code: status, response };
  // Same key, different payload: we cannot tell what was sent under that key.
  if (status === 409) return { kind: 'UNCERTAIN', code: status, response };
  if (status === 429 || status >= 500) return { kind: 'RETRY', code: status, response };
  if (status === 400 || status === 422) {
    const recipientUnknown = /\bto\b|recipient|invalid_to_address/i.test(
      `${body.name ?? ''} ${body.message ?? ''}`,
    );
    return { kind: 'PERMANENT', code: status, response, recipientUnknown };
  }
  return { kind: 'PERMANENT', code: status, response, recipientUnknown: false };
}

export async function sendViaResend(
  apiKey: string,
  email: ResendEmail,
  fetchImpl: FetchLike = fetch,
): Promise<ResendOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${RESEND_API}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': email.idempotencyKey,
      },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        reply_to: email.replyTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: email.headers,
        attachments: email.attachments.length ? email.attachments : undefined,
        tags: email.tags,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // No answer. The idempotency key makes a retry safe: Resend will not send twice.
    return {
      kind: 'RETRY',
      code: null,
      response: `Resend request failed: ${(error as Error).name}`,
    };
  }
  const body = (await response.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    message?: string;
  };
  return classifyResendResponse(response.status, body);
}

export interface ResendKeyCheck {
  ok: boolean;
  /** 'full' can manage the account; 'sending' can only send (recommended for campaigns). */
  access: 'full' | 'sending' | null;
  domain: { name: string; status: string } | null;
  message: string;
}

/**
 * Proves the key without sending anything. A sending-only key cannot list
 * domains, so a deliberately incomplete send request is used: Resend validates
 * the key (401/403) before the payload (422), and an incomplete payload is
 * never sent.
 */
export async function checkResendKey(
  apiKey: string,
  fromAddress: string,
  fetchImpl: FetchLike = fetch,
): Promise<ResendKeyCheck> {
  const domainName = fromAddress.split('@')[1] ?? '';
  try {
    const domains = await fetchImpl(`${RESEND_API}/domains`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await domains.json().catch(() => ({}))) as {
      data?: { name: string; status: string }[];
      name?: string;
    };
    if (domains.status === 200) {
      const domain = body.data?.find((d) => d.name === domainName) ?? null;
      return {
        ok: domain?.status === 'verified',
        access: 'full',
        domain,
        message: domain
          ? domain.status === 'verified'
            ? `Key works. ${domainName} is verified in Resend. A sending-only key is recommended for campaigns.`
            : `${domainName} is ${domain.status} in Resend; finish verification first.`
          : `${domainName} is not added to this Resend account.`,
      };
    }
    if (domains.status !== 401 || body.name !== 'restricted_api_key') {
      return { ok: false, access: null, domain: null, message: 'Resend rejected the API key.' };
    }
    const probe = await fetchImpl(`${RESEND_API}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // No recipient and no content: Resend refuses it after checking the key.
      body: JSON.stringify({ from: fromAddress }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const probeBody = (await probe.json().catch(() => ({}))) as { name?: string; message?: string };
    if (probe.status === 422 || probe.status === 400) {
      return {
        ok: true,
        access: 'sending',
        domain: null,
        message: 'Key works (sending-only). No email was sent.',
      };
    }
    return {
      ok: false,
      access: 'sending',
      domain: null,
      message: describe(probe.status, probeBody),
    };
  } catch (error) {
    return {
      ok: false,
      access: null,
      domain: null,
      message: `Resend could not be reached (${(error as Error).name}).`,
    };
  }
}

export interface DnsLookups {
  resolveTxt?: (name: string) => Promise<string[][]>;
  resolveMx?: (name: string) => Promise<{ exchange: string; priority: number }[]>;
}

export interface SendingDomainCheck {
  domain: string;
  dkim: boolean;
  returnPathMx: boolean;
  returnPathSpf: boolean;
  dmarc: string | null;
  ok: boolean;
}

/**
 * The DNS Resend requires for a sending domain: DKIM at resend._domainkey,
 * and a return path at send.<domain> (MX + SPF). Checked from public DNS, so
 * it holds whatever kind of key is in use. DMARC is reported, not required.
 */
export async function checkSendingDomainDns(
  fromAddress: string,
  lookups: DnsLookups = {},
): Promise<SendingDomainCheck> {
  const domain = (fromAddress.split('@')[1] ?? '').toLowerCase();
  const txt = lookups.resolveTxt ?? dnsResolveTxt;
  const mx = lookups.resolveMx ?? dnsResolveMx;
  const text = async (name: string) => {
    try {
      return (await txt(name)).map((parts) => parts.join(''));
    } catch {
      return [];
    }
  };
  const [dkimRecords, mxRecords, spfRecords, dmarcRecords] = await Promise.all([
    text(`resend._domainkey.${domain}`),
    mx(`send.${domain}`).catch(() => []),
    text(`send.${domain}`),
    text(`_dmarc.${domain}`),
  ]);
  const dkim = dkimRecords.some((r) => /p=[A-Za-z0-9+/=]{100,}/.test(r));
  const returnPathMx = mxRecords.length > 0;
  const returnPathSpf = spfRecords.some((r) => /^v=spf1\b/i.test(r));
  return {
    domain,
    dkim,
    returnPathMx,
    returnPathSpf,
    dmarc: dmarcRecords.find((r) => /^v=DMARC1/i.test(r)) ?? null,
    ok: Boolean(domain) && dkim && returnPathMx && returnPathSpf,
  };
}

/** Delivery status of one sent email, for reconciliation when a webhook was missed. */
export async function fetchResendEmailStatus(
  apiKey: string,
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ status: number; lastEvent: string | null }> {
  try {
    const res = await fetchImpl(`${RESEND_API}/emails/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { last_event?: string };
    return { status: res.status, lastEvent: body.last_event ?? null };
  } catch {
    return { status: 0, lastEvent: null };
  }
}
