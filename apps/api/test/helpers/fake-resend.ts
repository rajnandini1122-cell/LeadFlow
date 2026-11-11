import { randomUUID } from 'node:crypto';

/**
 * An in-memory Resend for the e2e suites: Contacts, Segments, Broadcasts and
 * the single-email API, behaving as Resend documents them (see
 * docs/email/LEADFLOW_RESEND_BROADCASTS.md). Nothing leaves the process.
 *
 * Faults can be injected per request, including the one that matters most:
 * 'lost-answer' — the request TAKES EFFECT and then the connection drops, so
 * the caller cannot know it worked.
 */

export type Fault = 'network' | 'lost-answer' | number;

interface Contact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  unsubscribed: boolean;
  segments: Set<string>;
}

export interface FakeResend {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  contacts: Map<string, Contact>;
  segments: Map<string, { id: string; name: string }>;
  broadcasts: Map<
    string,
    {
      id: string;
      status: string;
      segmentId: string;
      html: string;
      from: string;
      replyTo: string;
      subject: string;
    }
  >;
  emails: {
    id: string;
    to: string;
    idempotencyKey: string | null;
    body: Record<string, unknown>;
  }[];
  /** Every request: method, path, Authorization header, body. */
  log: { method: string; path: string; auth: string; body: Record<string, unknown> | null }[];
  /** Broadcast deliveries: one entry per (broadcast, address) actually sent. */
  broadcastDeliveries: { broadcastId: string; email: string }[];
  /** Any PATCH that tried to set unsubscribed:false on an existing contact. */
  resubscribeAttempts: string[];
  fault: (method: string, pathPattern: RegExp, fault: Fault, times?: number) => void;
  removeFromSegmentSupported: boolean;
  reset: () => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function createFakeResend(options: {
  fullAccessKeys: string[];
  domains?: { name: string; status: string }[];
}): FakeResend {
  const faults: { method: string; pattern: RegExp; fault: Fault; times: number }[] = [];
  const idempotency = new Map<string, { status: number; body: unknown }>();
  const state: FakeResend = {
    contacts: new Map(),
    segments: new Map(),
    broadcasts: new Map(),
    emails: [],
    log: [],
    broadcastDeliveries: [],
    resubscribeAttempts: [],
    removeFromSegmentSupported: true,
    fault: (method, pattern, fault, times = 1) => faults.push({ method, pattern, fault, times }),
    reset: () => {
      state.contacts.clear();
      state.segments.clear();
      state.broadcasts.clear();
      state.emails.length = 0;
      state.log.length = 0;
      state.broadcastDeliveries.length = 0;
      state.resubscribeAttempts.length = 0;
      state.removeFromSegmentSupported = true;
      faults.length = 0;
      idempotency.clear();
    },
    fetch: async (url, init) => {
      const u = new URL(url);
      const method = (init.method ?? 'GET').toUpperCase();
      const path = u.pathname;
      const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
      const auth = headers.get('authorization') ?? '';
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      state.log.push({ method, path: path + u.search, auth, body });

      const key = auth.replace(/^Bearer /, '');
      const fullAccess = options.fullAccessKeys.includes(key);
      if (!key.startsWith('re_'))
        return json(401, { name: 'validation_error', message: 'API key is invalid' });

      const faultIndex = faults.findIndex(
        (f) => f.method === method && f.pattern.test(path) && f.times > 0,
      );
      const fault = faultIndex >= 0 ? faults[faultIndex]!.fault : null;
      if (faultIndex >= 0) faults[faultIndex]!.times--;
      if (fault === 'network') throw new TypeError('fetch failed');
      if (typeof fault === 'number')
        return json(fault, { name: 'injected', message: `injected ${fault}` });

      const respond = (status: number, payload: unknown) => {
        if (fault === 'lost-answer')
          throw new TypeError('fetch failed after the request was processed');
        return json(status, payload);
      };

      // --- domains (key check) ------------------------------------------------------
      if (method === 'GET' && path === '/domains') {
        if (!fullAccess)
          return json(401, {
            name: 'restricted_api_key',
            message: 'This API key is restricted to only send emails',
          });
        return respond(200, { data: options.domains ?? [] });
      }

      // --- single email API ---------------------------------------------------------
      if (method === 'POST' && path === '/emails') {
        if (!body?.['to'])
          return json(422, { name: 'validation_error', message: 'Missing `to` field.' });
        const idem = headers.get('idempotency-key');
        if (idem && idempotency.has(idem)) {
          const previous = idempotency.get(idem)!;
          return respond(previous.status, previous.body);
        }
        const id = randomUUID();
        state.emails.push({ id, to: (body['to'] as string[])[0]!, idempotencyKey: idem, body });
        if (idem) idempotency.set(idem, { status: 200, body: { id } });
        return respond(200, { id });
      }

      if (!fullAccess)
        return json(401, {
          name: 'restricted_api_key',
          message: 'This API key is restricted to only send emails',
        });

      // --- contacts -------------------------------------------------------------------
      const contactMatch = /^\/contacts\/([^/]+)$/.exec(path);
      if (contactMatch) {
        const email = decodeURIComponent(contactMatch[1]!).toLowerCase();
        const contact = state.contacts.get(email);
        if (method === 'GET') {
          if (!contact) return json(404, { name: 'not_found', message: 'Contact not found' });
          return respond(200, { object: 'contact', ...contact, segments: undefined });
        }
        if (method === 'PATCH') {
          if (!contact) return json(404, { name: 'not_found', message: 'Contact not found' });
          if (body?.['unsubscribed'] === false) state.resubscribeAttempts.push(email);
          if (typeof body?.['unsubscribed'] === 'boolean')
            contact.unsubscribed = body['unsubscribed'] as boolean;
          if (typeof body?.['first_name'] === 'string')
            contact.first_name = body['first_name'] as string;
          if (typeof body?.['last_name'] === 'string')
            contact.last_name = body['last_name'] as string;
          return respond(200, { object: 'contact', id: contact.id });
        }
      }
      if (method === 'POST' && path === '/contacts') {
        const email = String(body?.['email'] ?? '').toLowerCase();
        if (state.contacts.has(email))
          return json(409, { name: 'already_exists', message: 'Contact already exists' });
        const contact: Contact = {
          id: randomUUID(),
          email,
          first_name: (body?.['first_name'] as string) ?? null,
          last_name: (body?.['last_name'] as string) ?? null,
          unsubscribed: body?.['unsubscribed'] === true,
          segments: new Set(),
        };
        state.contacts.set(email, contact);
        return respond(200, { object: 'contact', id: contact.id });
      }
      if (method === 'GET' && path === '/contacts') {
        const segmentId = u.searchParams.get('segment_id');
        const limit = Number(u.searchParams.get('limit') ?? 20);
        const after = u.searchParams.get('after');
        let list = [...state.contacts.values()].filter(
          (c) => !segmentId || c.segments.has(segmentId),
        );
        if (after) list = list.slice(list.findIndex((c) => c.id === after) + 1);
        const page = list.slice(0, limit);
        return respond(200, {
          object: 'list',
          has_more: list.length > limit,
          data: page.map((c) => ({
            id: c.id,
            email: c.email,
            first_name: c.first_name,
            last_name: c.last_name,
            unsubscribed: c.unsubscribed,
          })),
        });
      }
      const segmentMembership = /^\/contacts\/([^/]+)\/segments\/([^/]+)$/.exec(path);
      if (segmentMembership) {
        const contact = state.contacts.get(decodeURIComponent(segmentMembership[1]!).toLowerCase());
        const segmentId = decodeURIComponent(segmentMembership[2]!);
        if (!contact || !state.segments.has(segmentId))
          return json(404, { name: 'not_found', message: 'Not found' });
        if (method === 'POST') {
          contact.segments.add(segmentId);
          return respond(200, { id: segmentId });
        }
        if (method === 'DELETE') {
          if (!state.removeFromSegmentSupported)
            return json(405, { name: 'method_not_allowed', message: 'Not supported' });
          contact.segments.delete(segmentId);
          return respond(200, { id: segmentId });
        }
      }

      // --- segments --------------------------------------------------------------------
      if (method === 'POST' && path === '/segments') {
        const id = randomUUID();
        state.segments.set(id, { id, name: String(body?.['name'] ?? '') });
        return respond(200, { object: 'segment', id, name: body?.['name'] });
      }

      // --- broadcasts --------------------------------------------------------------------
      if (method === 'POST' && path === '/broadcasts') {
        const id = randomUUID();
        state.broadcasts.set(id, {
          id,
          status: 'draft',
          segmentId: String(body?.['segment_id']),
          html: String(body?.['html'] ?? ''),
          from: String(body?.['from'] ?? ''),
          replyTo: String(body?.['reply_to'] ?? ''),
          subject: String(body?.['subject'] ?? ''),
        });
        return respond(200, { id });
      }
      const broadcastMatch = /^\/broadcasts\/([^/]+)(\/send)?$/.exec(path);
      if (broadcastMatch) {
        const broadcast = state.broadcasts.get(decodeURIComponent(broadcastMatch[1]!));
        if (!broadcast) return json(404, { name: 'not_found', message: 'Broadcast not found' });
        if (method === 'GET' && !broadcastMatch[2])
          return respond(200, { object: 'broadcast', id: broadcast.id, status: broadcast.status });
        if (method === 'POST' && broadcastMatch[2]) {
          // Only a draft can be sent: a second send of the same broadcast is refused.
          if (broadcast.status !== 'draft')
            return json(422, { name: 'validation_error', message: 'Broadcast already sent' });
          broadcast.status = 'queued';
          for (const contact of state.contacts.values()) {
            if (contact.segments.has(broadcast.segmentId) && !contact.unsubscribed) {
              state.broadcastDeliveries.push({ broadcastId: broadcast.id, email: contact.email });
            }
          }
          return respond(200, { id: broadcast.id });
        }
      }
      return json(404, { name: 'not_found', message: `No fake route for ${method} ${path}` });
    },
  };
  return state;
}

/** Public DNS answers for a sending domain that Resend has verified. */
export function verifiedDomainDns(domain: string) {
  return {
    resolveTxt: async (name: string) => {
      if (name === `resend._domainkey.${domain}`) return [[`p=${'A'.repeat(200)}`]];
      if (name === `send.${domain}`) return [['v=spf1 include:amazonses.com ~all']];
      if (name === `_dmarc.${domain.split('.').slice(-2).join('.')}` || name === `_dmarc.${domain}`)
        return [['v=DMARC1; p=none;']];
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    },
    resolveMx: async (name: string) => {
      if (name === `send.${domain}`)
        return [{ exchange: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }];
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    },
  };
}
