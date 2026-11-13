import { randomBytes } from 'node:crypto';
import { signSvix, verifySvixSignature } from '../mailbox/svix-signature';
import {
  checkSendingDomainDns,
  classifyResendResponse,
  sendViaResend,
} from '../mailbox/resend-transport';
import { broadcastContent } from './broadcast.service';
import { ResendMarketingClient } from './resend-marketing.client';

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
    expect(out.text).toContain('marketing emails: {{{RESEND_UNSUBSCRIBE_URL}}}');
  });
});

describe('ResendMarketingClient — documented endpoints, pagination and failures', () => {
  type Call = { method: string; url: string };
  const stub = (pages: (Response | Error)[]) => {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? 'GET', url });
      const next = pages.shift();
      if (!next) throw new Error('unexpected call');
      if (next instanceof Error) throw next;
      return next;
    };
    return { calls, client: new ResendMarketingClient('re_test', fetchImpl, 0) };
  };
  const page = (data: unknown[], hasMore: boolean) =>
    new Response(JSON.stringify({ object: 'list', has_more: hasMore, data }), { status: 200 });

  it("follows a contact's segment pages with `after` = the last id", async () => {
    const { calls, client } = stub([
      page([{ id: 'seg_1' }, { id: 'seg_2' }], true),
      page([{ id: 'seg_3' }], false),
    ]);
    expect(await client.contactSegments('A@x.example')).toEqual({
      kind: 'ok',
      status: 200,
      body: ['seg_1', 'seg_2', 'seg_3'],
    });
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, '')}`)).toEqual([
      'GET /contacts/A%40x.example/segments?limit=100',
      'GET /contacts/A%40x.example/segments?limit=100&after=seg_2',
    ]);
  });

  it('never presents a partial list as whole: a failed page fails the whole read', async () => {
    const { client } = stub([
      page([{ id: 'c1', email: 'a@x.example' }], true),
      new TypeError('fetch failed'),
    ]);
    expect((await client.listSegment('seg_1')).kind).toBe('network');
    const second = stub([page([{ id: 'seg_1' }], true), new Response('{}', { status: 429 })]);
    expect(await second.client.contactSegments('a@x.example')).toMatchObject({
      kind: 'http',
      status: 429,
    });
  });

  it('refuses to verify an unbounded listing rather than guessing', async () => {
    const { client } = stub([page([{ id: 'seg_1' }], true), page([{ id: 'seg_2' }], true)]);
    expect(await client.contactSegments('a@x.example', 2)).toMatchObject({
      kind: 'http',
      error: 'too many segments to verify',
    });
  });

  it('removes with DELETE /contacts/{email}/segments/{id} and cancels with POST /broadcasts/{id}/cancel', async () => {
    const { calls, client } = stub([
      new Response(JSON.stringify({ object: 'contact_segment', id: 'seg_1', deleted: true }), {
        status: 200,
      }),
      new Response(JSON.stringify({ object: 'broadcast', id: 'b_1' }), { status: 200 }),
    ]);
    expect((await client.removeFromSegment('a@x.example', 'seg_1')).kind).toBe('ok');
    expect((await client.cancelBroadcast('b_1')).kind).toBe('ok');
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, '')}`)).toEqual([
      'DELETE /contacts/a%40x.example/segments/seg_1',
      'POST /broadcasts/b_1/cancel',
    ]);
  });

  it('stays under 10 requests per second', async () => {
    const fetchImpl = async () => page([], false);
    const client = new ResendMarketingClient('re_test', fetchImpl);
    const started = Date.now();
    for (let i = 0; i < 4; i++) await client.contactSegments('a@x.example');
    expect(Date.now() - started).toBeGreaterThanOrEqual(3 * 100);
  });
});
