import { RESEND_API, type FetchLike } from '../mailbox/resend-transport';

/**
 * Resend Marketing (Contacts, Segments, Broadcasts) over HTTPS.
 *
 * Every call returns one of three things, and the broadcast state machine
 * treats them differently:
 *   ok       Resend answered 2xx;
 *   http     Resend answered with an error — a definite "this did not happen";
 *   network  no answer — the request may or may not have taken effect.
 *
 * API facts this relies on (docs re-checked 2026-11-11, see
 * docs/email/LEADFLOW_RESEND_BROADCASTS.md): contacts are addressed by id or
 * email; POST and DELETE /contacts/{email}/segments/{segmentId} add to and
 * remove from a segment; GET /contacts/{email}/segments lists a contact's segments;
 * GET /contacts?segment_id= lists a segment (100 per page, `after` cursor);
 * broadcasts are created as drafts and sent with POST /broadcasts/{id}/send,
 * which documents NO idempotency key; broadcast status is one of draft,
 * scheduled, queued, sent, canceled.
 */

const TIMEOUT_MS = 20_000;

/** Resend allows 10 requests/second per team; one client stays under it. */
const MIN_INTERVAL_MS = 110;

export type ApiResult<T> =
  | { kind: 'ok'; status: number; body: T }
  | { kind: 'http'; status: number; error: string }
  | { kind: 'network'; error: string };

export interface ResendContact {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  unsubscribed: boolean;
}

export type BroadcastStatus = 'draft' | 'scheduled' | 'queued' | 'sent' | 'canceled';

export class ResendMarketingClient {
  private nextCallAt = 0;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly minIntervalMs = MIN_INTERVAL_MS,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const wait = this.nextCallAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.nextCallAt = Date.now() + this.minIntervalMs;
    let response: Response;
    try {
      response = await this.fetchImpl(`${RESEND_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: 'network', error: (error as Error).name };
    }
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status >= 200 && response.status < 300) {
      return { kind: 'ok', status: response.status, body: parsed as T };
    }
    const name = typeof parsed['name'] === 'string' ? parsed['name'] : '';
    const message = typeof parsed['message'] === 'string' ? parsed['message'] : '';
    return {
      kind: 'http',
      status: response.status,
      error: `${response.status} ${name} ${message}`.trim().slice(0, 300),
    };
  }

  getContact(email: string) {
    return this.call<ResendContact>('GET', `/contacts/${encodeURIComponent(email)}`);
  }

  /** New contacts only. `unsubscribed` is never sent as false for a known contact. */
  createContact(input: { email: string; firstName: string | null; lastName: string | null }) {
    return this.call<{ id: string }>('POST', '/contacts', {
      email: input.email,
      ...(input.firstName ? { first_name: input.firstName } : {}),
      ...(input.lastName ? { last_name: input.lastName } : {}),
      unsubscribed: false,
    });
  }

  /** Names only — this method cannot change subscription status. */
  updateContactNames(email: string, input: { firstName: string | null; lastName: string | null }) {
    return this.call<{ id: string }>('PATCH', `/contacts/${encodeURIComponent(email)}`, {
      ...(input.firstName ? { first_name: input.firstName } : {}),
      ...(input.lastName ? { last_name: input.lastName } : {}),
    });
  }

  /** The only way LeadFlow changes subscription status at Resend: to unsubscribed. */
  unsubscribeContact(email: string) {
    return this.call<{ id: string }>('PATCH', `/contacts/${encodeURIComponent(email)}`, {
      unsubscribed: true,
    });
  }

  createSegment(name: string) {
    return this.call<{ id: string }>('POST', '/segments', { name });
  }

  addToSegment(email: string, segmentId: string) {
    return this.call<{ id: string }>(
      'POST',
      `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
    );
  }

  /** DELETE /contacts/{id|email}/segments/{segmentId} ("Delete Contact Segment"). */
  removeFromSegment(email: string, segmentId: string) {
    return this.call<{ id: string }>(
      'DELETE',
      `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
    );
  }

  /**
   * The segments one contact belongs to (GET /contacts/{id|email}/segments,
   * paginated). Used to verify membership contact by contact, because the
   * segment listing documents no consistency or ordering guarantee.
   */
  async contactSegments(email: string, maxPages = 10): Promise<ApiResult<string[]>> {
    const ids: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
      const res = await this.call<{ data?: { id: string }[]; has_more?: boolean }>(
        'GET',
        `/contacts/${encodeURIComponent(email)}/segments?${query}`,
      );
      if (res.kind !== 'ok') return res;
      const data = res.body.data ?? [];
      ids.push(...data.map((s) => s.id));
      if (!res.body.has_more || data.length === 0) return { kind: 'ok', status: 200, body: ids };
      after = data[data.length - 1]!.id;
    }
    return { kind: 'http', status: 0, error: 'too many segments to verify' };
  }

  /** Every member of a segment, or a failure — never a partial list presented as whole. */
  async listSegment(segmentId: string, maxPages = 60): Promise<ApiResult<ResendContact[]>> {
    const all: ResendContact[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({
        segment_id: segmentId,
        limit: '100',
        ...(after ? { after } : {}),
      });
      const res = await this.call<{ data?: ResendContact[]; has_more?: boolean }>(
        'GET',
        `/contacts?${query}`,
      );
      if (res.kind !== 'ok') return res;
      const data = res.body.data ?? [];
      all.push(...data);
      if (!res.body.has_more || data.length === 0) return { kind: 'ok', status: 200, body: all };
      after = data[data.length - 1]!.id;
    }
    return { kind: 'http', status: 0, error: 'segment too large to verify' };
  }

  /** Unsubscribed contacts across the account, for reconciliation (bounded). */
  async listUnsubscribed(maxPages = 20): Promise<ApiResult<string[]>> {
    const out: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
      const res = await this.call<{ data?: ResendContact[]; has_more?: boolean }>(
        'GET',
        `/contacts?${query}`,
      );
      if (res.kind !== 'ok') return res;
      const data = res.body.data ?? [];
      out.push(...data.filter((c) => c.unsubscribed).map((c) => c.email.toLowerCase()));
      if (!res.body.has_more || data.length === 0) break;
      after = data[data.length - 1]!.id;
    }
    return { kind: 'ok', status: 200, body: out };
  }

  createDraftBroadcast(input: {
    segmentId: string;
    from: string;
    replyTo: string;
    subject: string;
    html: string;
    text: string;
    name: string;
  }) {
    return this.call<{ id: string }>('POST', '/broadcasts', {
      segment_id: input.segmentId,
      from: input.from,
      reply_to: input.replyTo,
      subject: input.subject,
      html: input.html,
      text: input.text,
      name: input.name,
    });
  }

  getBroadcast(id: string) {
    return this.call<{ id: string; status: BroadcastStatus; sent_at?: string | null }>(
      'GET',
      `/broadcasts/${encodeURIComponent(id)}`,
    );
  }

  /**
   * POST /broadcasts/{id}/cancel — queued or scheduled broadcasts only.
   * Queued → canceled (emails already sent are NOT recalled); scheduled → draft.
   */
  cancelBroadcast(id: string) {
    return this.call<{ id: string }>('POST', `/broadcasts/${encodeURIComponent(id)}/cancel`, {});
  }

  sendBroadcast(id: string) {
    return this.call<{ id: string }>('POST', `/broadcasts/${encodeURIComponent(id)}/send`, {});
  }
}
