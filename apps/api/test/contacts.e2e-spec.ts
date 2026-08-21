import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Phase 5 — contacts, duplicate detection and the merge workflow.
 *
 * Merge is the most destructive operation in the product: it repoints every
 * lead of one person onto another and cannot be undone by the user. So the
 * cases that matter most here are the ones that must be REFUSED — a merge
 * reaching into another tenant, and a merge performed by someone who may edit
 * contacts but was never granted the right to combine them.
 */
describe('Contacts', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Distinct numbers per call: the leads mobile index is unique per org. */
  let counter = 0;
  const mobile = (): string => {
    counter += 1;
    return `415555${String(1000 + counter)}`;
  };

  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  const makeContact = async (
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; mobile: string }> => {
    const number = (overrides['mobile'] as string) ?? mobile();
    const response = await ctx
      .http()
      .post('/api/v1/contacts')
      .set(auth(token))
      .send({ firstName: 'Dana', lastName: 'Reyes', ...overrides, mobile: number })
      .expect(201);

    return { id: response.body.data.id as string, mobile: response.body.data.mobile as string };
  };

  /** Creates a lead, which links or creates the contact for that mobile. */
  const makeLead = async (
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; mobile: string }> => {
    const number = (overrides['mobile'] as string) ?? mobile();
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token))
      .send({
        firstName: 'Sam',
        lastName: 'Ellis',
        nextFollowUpAt: inDays(2),
        ...overrides,
        mobile: number,
      })
      .expect(201);

    return { id: response.body.data.id as string, mobile: response.body.data.mobile as string };
  };

  /** The contact the given E.164 mobile resolved to, via the tenant-scoped API. */
  const contactIdForMobile = async (token: string, e164: string): Promise<string> => {
    const response = await ctx
      .http()
      .get(`/api/v1/contacts?search=${encodeURIComponent(e164)}`)
      .set(auth(token))
      .expect(200);

    const items = response.body.data.items as { id: string }[];
    expect(items.length).toBeGreaterThan(0);
    return items[0]!.id;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('never lists another organization’s contacts', async () => {
      const foreign = await makeContact(ctx.orgB.owner.accessToken, { firstName: 'Bee' });

      const response = await ctx
        .http()
        .get('/api/v1/contacts?limit=100')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const ids = (response.body.data.items as { id: string }[]).map((item) => item.id);
      expect(ids).not.toContain(foreign.id);
    });

    it('returns 404 — not 403 — for another organization’s contact', async () => {
      const foreign = await makeContact(ctx.orgB.owner.accessToken);

      // 403 would confirm the id exists, turning the endpoint into an
      // enumeration oracle. 404 is indistinguishable from "never existed".
      const response = await ctx
        .http()
        .get(`/api/v1/contacts/${foreign.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(404);

      expect(response.body.error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    it('refuses to update another organization’s contact', async () => {
      const foreign = await makeContact(ctx.orgB.owner.accessToken, { city: 'Austin' });

      await ctx
        .http()
        .patch(`/api/v1/contacts/${foreign.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ city: 'Hijacked' })
        .expect(404);

      const check = await ctx
        .http()
        .get(`/api/v1/contacts/${foreign.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(check.body.data.city).toBe('Austin');
    });

    it('refuses a merge whose SOURCE belongs to another organization', async () => {
      const foreign = await makeContact(ctx.orgB.owner.accessToken);
      const mine = await makeContact(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId: foreign.id, targetId: mine.id })
        .expect(404);

      // The foreign record must be untouched — not merged, not tombstoned.
      const check = await ctx
        .http()
        .get(`/api/v1/contacts/${foreign.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(check.body.data.mergedIntoId).toBeNull();
    });

    it('refuses a merge whose TARGET belongs to another organization', async () => {
      const foreign = await makeContact(ctx.orgB.owner.accessToken);
      const mine = await makeContact(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId: mine.id, targetId: foreign.id })
        .expect(404);

      // The worst outcome would be Org A's leads landing on Org B's contact —
      // a silent, permanent cross-tenant data leak.
      const check = await ctx
        .http()
        .get(`/api/v1/contacts/${foreign.id}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(check.body.data.leads).toHaveLength(0);
    });

    it('does not report a matching number in another organization as a duplicate', async () => {
      const shared = mobile();
      await makeContact(ctx.orgA.owner.accessToken, { mobile: shared });
      await makeContact(ctx.orgB.owner.accessToken, { mobile: shared });

      const response = await ctx
        .http()
        .get('/api/v1/contacts/duplicates')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const values = (response.body.data as { value: string }[]).map((group) => group.value);
      expect(values).not.toContain(`+1${shared}`);
    });
  });

  // ---------------------------------------------------------------------------
  // Authorization — enforced by the API, never by the UI alone
  // ---------------------------------------------------------------------------

  describe('authorization', () => {
    it('lets a sales rep read contacts', async () => {
      await ctx.http().get('/api/v1/contacts').set(auth(ctx.orgA.rep.accessToken)).expect(200);
    });

    it('refuses a sales rep the right to edit a contact', async () => {
      const contact = await makeContact(ctx.orgA.owner.accessToken);

      const response = await ctx
        .http()
        .patch(`/api/v1/contacts/${contact.id}`)
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ city: 'Nowhere' })
        .expect(403);

      expect(response.body.error.code).toBe(ERROR_CODES.FORBIDDEN);
    });

    it('refuses a sales rep the right to merge', async () => {
      const source = await makeContact(ctx.orgA.owner.accessToken);
      const target = await makeContact(ctx.orgA.owner.accessToken);

      // contact.merge is deliberately separate from contact.update: editing a
      // record is recoverable, combining two is not.
      await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ sourceId: source.id, targetId: target.id })
        .expect(403);

      const check = await ctx
        .http()
        .get(`/api/v1/contacts/${source.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(check.body.data.mergedIntoId).toBeNull();
    });

    it('refuses a sales rep the duplicate review screen', async () => {
      await ctx
        .http()
        .get('/api/v1/contacts/duplicates')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Leads are attached to contacts
  // ---------------------------------------------------------------------------

  describe('lead to contact linkage', () => {
    it('reuses the same contact when the same person enquires twice', async () => {
      const number = mobile();
      const first = await makeLead(ctx.orgA.owner.accessToken, { mobile: number });

      // A returning customer is a SECOND lead on the SAME person; that is what
      // keeps their history alive after the first deal closes.
      await ctx
        .http()
        .patch(`/api/v1/leads/${first.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ status: 'LOST', lostReason: 'Chose a competitor' })
        .expect(200);

      const second = await makeLead(ctx.orgA.owner.accessToken, { mobile: number });
      expect(second.id).not.toBe(first.id);

      const contactId = await contactIdForMobile(ctx.orgA.owner.accessToken, first.mobile);
      const contact = await ctx
        .http()
        .get(`/api/v1/contacts/${contactId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const leadIds = (contact.body.data.leads as { id: string }[]).map((lead) => lead.id);
      expect(leadIds).toContain(first.id);
      expect(leadIds).toContain(second.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicate detection
  // ---------------------------------------------------------------------------

  describe('duplicate detection', () => {
    it('reports two contacts sharing a mobile', async () => {
      const shared = mobile();
      const first = await makeContact(ctx.orgA.owner.accessToken, { mobile: shared });
      await makeContact(ctx.orgA.owner.accessToken, { mobile: shared, firstName: 'Danna' });

      const response = await ctx
        .http()
        .get(`/api/v1/contacts/${first.id}/duplicates`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].matchedOn).toContain('mobile');
    });

    it('does not treat a shared name and company as a duplicate', async () => {
      const first = await makeContact(ctx.orgA.owner.accessToken, {
        firstName: 'John',
        lastName: 'Smith',
        companyName: 'Acme',
      });
      await makeContact(ctx.orgA.owner.accessToken, {
        firstName: 'John',
        lastName: 'Smith',
        companyName: 'Acme',
      });

      // Two people can genuinely share a name at one company. Suggesting a
      // merge here is how two real customers get combined by accident.
      const response = await ctx
        .http()
        .get(`/api/v1/contacts/${first.id}/duplicates`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(response.body.data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Merge
  // ---------------------------------------------------------------------------

  describe('merging', () => {
    it('moves every lead onto the surviving contact and keeps a tombstone', async () => {
      const lead = await makeLead(ctx.orgA.owner.accessToken);
      const sourceId = await contactIdForMobile(ctx.orgA.owner.accessToken, lead.mobile);
      const target = await makeContact(ctx.orgA.owner.accessToken, { firstName: 'Survivor' });

      const merged = await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId, targetId: target.id })
        .expect(200);

      expect(merged.body.data.leadsMoved).toBe(1);

      const after = await ctx
        .http()
        .get(`/api/v1/contacts/${target.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect((after.body.data.leads as { id: string }[]).map((l) => l.id)).toContain(lead.id);

      // Nothing is deleted: the absorbed record survives pointing at its
      // replacement, so a stale link still resolves instead of dangling.
      const tombstone = await ctx
        .http()
        .get(`/api/v1/contacts/${sourceId}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(tombstone.body.data.mergedIntoId).toBe(target.id);
    });

    it('preserves the lead activity history and records the merge on it', async () => {
      const lead = await makeLead(ctx.orgA.owner.accessToken);

      const before = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}/activities`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);
      const countBefore = (before.body.data.items as unknown[]).length;

      const sourceId = await contactIdForMobile(ctx.orgA.owner.accessToken, lead.mobile);
      const target = await makeContact(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId, targetId: target.id })
        .expect(200);

      const after = await ctx
        .http()
        .get(`/api/v1/leads/${lead.id}/activities`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const items = after.body.data.items as { description: string }[];
      expect(items.length).toBe(countBefore + 1);
      expect(items.some((item) => /merged/i.test(item.description))).toBe(true);
    });

    it('applies the caller field choices and otherwise keeps the target values', async () => {
      const source = await makeContact(ctx.orgA.owner.accessToken, {
        firstName: 'Chosen',
        city: 'Ignored',
      });
      const target = await makeContact(ctx.orgA.owner.accessToken, {
        firstName: 'Discarded',
        city: 'Kept',
      });

      await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId: source.id, targetId: target.id, fieldChoices: { firstName: 'source' } })
        .expect(200);

      const after = await ctx
        .http()
        .get(`/api/v1/contacts/${target.id}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(after.body.data.firstName).toBe('Chosen');
      // Not chosen, so the surviving record keeps its own value rather than
      // having it silently overwritten.
      expect(after.body.data.city).toBe('Kept');
    });

    it('refuses to merge a contact into itself', async () => {
      const contact = await makeContact(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId: contact.id, targetId: contact.id })
        .expect(400);
    });

    it('refuses to merge a record that has already been merged away', async () => {
      const source = await makeContact(ctx.orgA.owner.accessToken);
      const target = await makeContact(ctx.orgA.owner.accessToken);
      const third = await makeContact(ctx.orgA.owner.accessToken);

      await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId: source.id, targetId: target.id })
        .expect(200);

      const response = await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId: source.id, targetId: third.id })
        .expect(409);

      expect(response.body.error.code).toBe(ERROR_CODES.CONFLICT);
    });
  });
});
