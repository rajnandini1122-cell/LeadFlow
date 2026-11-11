import { randomBytes } from 'node:crypto';
import { signSvix, verifySvixSignature } from '../mailbox/svix-signature';
import {
  checkSendingDomainDns,
  classifyResendResponse,
  sendViaResend,
} from '../mailbox/resend-transport';
import { broadcastContent } from './broadcast.service';

const secret = `whsec_${randomBytes(32).toString('base64')}`;
const body = Buffer.from('{"type":"email.sent"}');
const now = new Date('2026-11-11T10:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));

describe('Svix webhook signatures', () => {
  const headers = (over: Partial<{ id: string; timestamp: string; signature: string }> = {}) => ({
    id: 'msg_1',
    timestamp: ts,
    signature: signSvix(secret, 'msg_1', ts, body.toString()),
    ...over,
  });

  it('accepts a correct signature', () => {
    expect(verifySvixSignature({ secret, ...headers(), rawBody: body, now })).toEqual({ ok: true });
  });

  it('accepts when any of several space-separated signatures matches (rotation at the sender)', () => {
    const good = signSvix(secret, 'msg_1', ts, body.toString());
    expect(
      verifySvixSignature({
        secret,
        ...headers({ signature: `v1,AAAA ${good}` }),
        rawBody: body,
        now,
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['a changed body', { rawBody: Buffer.from('{"type":"email.bounced"}') }, 'BAD_SIGNATURE'],
    ['another secret', { secret: `whsec_${randomBytes(32).toString('base64')}` }, 'BAD_SIGNATURE'],
    ['a stale timestamp', { now: new Date(now.getTime() + 6 * 60_000) }, 'STALE'],
    ['a future timestamp', { now: new Date(now.getTime() - 6 * 60_000) }, 'STALE'],
    ['a missing header', { id: undefined }, 'MISSING'],
    ['a v0 signature', { signature: 'v0,abc' }, 'BAD_SIGNATURE'],
  ])('refuses %s', (_label, over, reason) => {
    const input = { secret, ...headers(), rawBody: body, now, ...over };
    expect(verifySvixSignature(input as Parameters<typeof verifySvixSignature>[0])).toEqual({
      ok: false,
      reason,
    });
  });
});

describe('Resend single-email outcomes', () => {
  it.each([
    [200, { id: 'e1' }, 'ACCEPTED'],
    [401, { name: 'validation_error' }, 'MAILBOX'],
    [403, { name: 'invalid_from_address' }, 'MAILBOX'],
    [429, { name: 'rate_limit_exceeded' }, 'RETRY'],
    [500, {}, 'RETRY'],
    [409, { name: 'concurrent_idempotent_requests' }, 'RETRY'],
    [409, { name: 'invalid_idempotent_request' }, 'UNCERTAIN'],
    [422, { name: 'validation_error', message: 'Invalid `to` field' }, 'PERMANENT'],
  ])('%i %j → %s', (status, body, kind) => {
    expect(classifyResendResponse(status, body).kind).toBe(kind);
  });

  it('no answer is a retry — the idempotency key makes it safe — and the key is sent', async () => {
    const seen: Headers[] = [];
    const outcome = await sendViaResend(
      're_key_12345678',
      {
        from: 'A <a@x.example>',
        to: 'b@y.example',
        replyTo: 'a@x.example',
        subject: 's',
        html: '<p>h</p>',
        text: 'h',
        headers: {},
        attachments: [],
        tags: [],
        idempotencyKey: 'leadflow-recipient-1',
      },
      async (_url, init) => {
        seen.push(new Headers(init.headers as ConstructorParameters<typeof Headers>[0]));
        throw new TypeError('fetch failed');
      },
    );
    expect(outcome.kind).toBe('RETRY');
    expect(seen[0]!.get('idempotency-key')).toBe('leadflow-recipient-1');
  });
});

describe('sending domain DNS', () => {
  const dns = (records: Record<string, string[]>, mx: Record<string, string[]>) => ({
    resolveTxt: async (name: string) => {
      if (!records[name]) throw new Error('ENOTFOUND');
      return records[name]!.map((r) => [r]);
    },
    resolveMx: async (name: string) => {
      if (!mx[name]) throw new Error('ENOTFOUND');
      return mx[name]!.map((exchange) => ({ exchange, priority: 10 }));
    },
  });

  it('needs DKIM and both return-path records', async () => {
    const complete = await checkSendingDomainDns(
      'news@news.example.com',
      dns(
        {
          'resend._domainkey.news.example.com': [`p=${'A'.repeat(200)}`],
          'send.news.example.com': ['v=spf1 include:amazonses.com ~all'],
        },
        { 'send.news.example.com': ['feedback-smtp.us-east-1.amazonses.com'] },
      ),
    );
    expect(complete).toMatchObject({
      domain: 'news.example.com',
      dkim: true,
      returnPathMx: true,
      returnPathSpf: true,
      ok: true,
      dmarc: null,
    });
    const noDkim = await checkSendingDomainDns(
      'news@news.example.com',
      dns({ 'send.news.example.com': ['v=spf1 ~all'] }, { 'send.news.example.com': ['x'] }),
    );
    expect(noDkim).toMatchObject({ dkim: false, ok: false });
  });
});

describe('broadcast content', () => {
  it('maps merge fields to Resend contact placeholders and uses Resend’s unsubscribe link', () => {
    const out = broadcastContent(
      {
        subject: 'From {{organization}}',
        html: '<p>Dear {{first_name}} {{last_name}}</p>',
        text: '',
        purpose: 'PROMOTIONAL',
      },
      'Acme',
    );
    expect(out.subject).toBe('From Acme');
    expect(out.html).toContain('Dear {{{contact.first_name}}} {{{contact.last_name}}}');
    expect(out.html).toContain('href="{{{RESEND_UNSUBSCRIBE_URL}}}"');
    expect(out.text).toContain('Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}');
  });
});
