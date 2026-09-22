import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * Phase 5 — CSV lead import and the aggregated dashboard.
 *
 * Import is the widest write path in the product: one request creates hundreds
 * of leads. So the cases that matter are the ones that stop a bad file, a
 * cross-tenant assignee, or an unauthorised caller from doing damage at scale.
 */
describe('Lead import and dashboard', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  const mobile = (): string => fixtureMobile();

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses a sales rep the preview endpoint', async () => {
      await ctx
        .http()
        .post('/api/v1/leads/import/preview')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ csv: `name,phone\nDana,${mobile()}` })
        .expect(403);
    });

    it('refuses a sales rep the import endpoint', async () => {
      // A rep may create leads one at a time; importing a file is a different
      // scale of action and carries its own permission.
      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ csv: `name,phone\nDana,${mobile()}`, defaultNextFollowUpAt: inDays(3) })
        .expect(403);
    });

    it('refuses an unauthenticated import outright', async () => {
      await ctx
        .http()
        .post('/api/v1/leads/import')
        .send({ csv: `name,phone\nDana,${mobile()}`, defaultNextFollowUpAt: inDays(3) })
        .expect(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------------

  describe('preview', () => {
    it('suggests a mapping and writes nothing', async () => {
      const number = mobile();

      const response = await ctx
        .http()
        .post('/api/v1/leads/import/preview')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv: `First Name,Mobile,Company\nDana,${number},Acme` })
        .expect(200);

      expect(response.body.data.mapping).toEqual({
        'First Name': 'firstName',
        Mobile: 'mobile',
        Company: 'companyName',
      });
      expect(response.body.data.totalRows).toBe(1);

      // A preview that created rows would be an import with a friendlier name.
      const leads = await ctx
        .http()
        .get(`/api/v1/leads?search=${number}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(leads.body.data.items).toHaveLength(0);
    });

    it('reports per-row validation errors instead of failing the file', async () => {
      const csv = [
        'firstName,mobile',
        `Valid,${mobile()}`,
        ',9820011999',
        'NoPhone,',
        'BadPhone,not-a-number',
      ].join('\n');

      const response = await ctx
        .http()
        .post('/api/v1/leads/import/preview')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv, defaultNextFollowUpAt: inDays(3) })
        .expect(200);

      expect(response.body.data.totalRows).toBe(4);
      expect(response.body.data.validRows).toBe(1);
      expect(response.body.data.invalidRows).toBe(3);

      const rows = response.body.data.rows as { line: number; errors: string[] }[];
      expect(rows.find((row) => row.line === 3)?.errors).toContain('firstName is empty');
      expect(rows.find((row) => row.line === 5)?.errors).toContain(
        'mobile is not a valid phone number',
      );
    });

    it('flags a row that duplicates an existing lead', async () => {
      const number = mobile();

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ firstName: 'Existing', mobile: number, nextFollowUpAt: inDays(1) })
        .expect(201);

      const response = await ctx
        .http()
        .post('/api/v1/leads/import/preview')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv: `firstName,mobile\nDana,${number}`, defaultNextFollowUpAt: inDays(3) })
        .expect(200);

      expect(response.body.data.duplicateRows).toBe(1);
      expect(response.body.data.rows[0].duplicateOf.kind).toBe('existing');
    });

    it('flags a row that duplicates an earlier row in the same file', async () => {
      const number = mobile();
      const csv = `firstName,mobile\nDana,${number}\nDana Again,${number}`;

      const response = await ctx
        .http()
        .post('/api/v1/leads/import/preview')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv, defaultNextFollowUpAt: inDays(3) })
        .expect(200);

      expect(response.body.data.rows[1].duplicateOf).toEqual({ line: 2, kind: 'file' });
    });

    it('names the required fields that no column maps to', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads/import/preview')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv: 'Internal Ref,Notes\nABC,hello' })
        .expect(200);

      expect(response.body.data.missingRequired).toEqual(['firstName', 'mobile']);
    });

    it('rejects a file it cannot read', async () => {
      await ctx
        .http()
        .post('/api/v1/leads/import/preview')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv: 'firstName,mobile' })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  describe('import', () => {
    it('creates the valid rows and reports the rest', async () => {
      const good = [mobile(), mobile()];
      const csv = [
        'firstName,lastName,mobile,companyName,estimatedValue',
        `Dana,Reyes,${good[0]},Acme,50000`,
        `Sam,Ellis,${good[1]},Globex,25000`,
        'Broken,Row,not-a-number,Initech,1000',
      ].join('\n');

      const response = await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv, defaultNextFollowUpAt: inDays(4) })
        .expect(200);

      expect(response.body.data.created).toBe(2);
      expect(response.body.data.failed).toBe(1);
      expect(response.body.data.failures[0].line).toBe(4);

      const leads = await ctx
        .http()
        .get(`/api/v1/leads?search=${good[0]}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(leads.body.data.items[0].name).toBe('Dana Reyes');
      expect(leads.body.data.items[0].estimatedValue).toBe('50000');
    });

    it('gives every imported lead a next follow-up', async () => {
      const number = mobile();

      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv: `firstName,mobile\nDana,${number}`, defaultNextFollowUpAt: inDays(5) })
        .expect(200);

      const leads = await ctx
        .http()
        .get(`/api/v1/leads?search=${number}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      // "No lead left behind" is a database CHECK constraint, and an import is
      // exactly the path that would otherwise bypass it in bulk.
      expect(leads.body.data.items[0].nextFollowUpAt).not.toBeNull();
    });

    it('attaches each imported lead to a contact', async () => {
      const number = mobile();

      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          csv: `firstName,mobile,companyName\nImported,${number},Initech`,
          defaultNextFollowUpAt: inDays(5),
        })
        .expect(200);

      const contacts = await ctx
        .http()
        .get(`/api/v1/contacts?search=${number}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(contacts.body.data.items).toHaveLength(1);
      expect(contacts.body.data.items[0].companyName).toBe('Initech');
    });

    it('skips rows duplicating an existing lead by default', async () => {
      const number = mobile();

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ firstName: 'Already', mobile: number, nextFollowUpAt: inDays(1) })
        .expect(201);

      const response = await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv: `firstName,mobile\nDana,${number}`, defaultNextFollowUpAt: inDays(3) })
        .expect(200);

      expect(response.body.data.created).toBe(0);
      expect(response.body.data.skipped).toBe(1);
    });

    it('refuses an assignee from another organization', async () => {
      // leads.assigned_to references the GLOBAL users table, so without this
      // check every row in the file would land on a foreign user.
      const response = await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          csv: `firstName,mobile\nDana,${mobile()}`,
          defaultNextFollowUpAt: inDays(3),
          assignedToId: ctx.orgB.rep.id,
        })
        .expect(400);

      expect(response.body.error.details.assignedToId).toBeDefined();
    });

    it('refuses to import when a required field is unmapped', async () => {
      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          csv: 'Internal Ref,Notes\nABC,hello',
          defaultNextFollowUpAt: inDays(3),
        })
        .expect(400);
    });

    it('requires a default follow-up date', async () => {
      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv: `firstName,mobile\nDana,${mobile()}` })
        .expect(400);
    });

    it('imports into the caller’s organization only', async () => {
      const number = mobile();

      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ csv: `firstName,mobile\nScoped,${number}`, defaultNextFollowUpAt: inDays(3) })
        .expect(200);

      const foreign = await ctx
        .http()
        .get(`/api/v1/leads?search=${number}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      expect(foreign.body.data.items).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  describe('pagination', () => {
    it('returns a total that counts beyond the current page', async () => {
      const rows = Array.from(
        { length: 6 },
        (_, index) => `Page${index},${mobile()},PageCo`,
      ).join('\n');

      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          csv: `firstName,mobile,companyName\n${rows}`,
          defaultNextFollowUpAt: inDays(3),
        })
        .expect(200);

      const first = await ctx
        .http()
        .get('/api/v1/leads?search=PageCo&limit=2')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(first.body.data.items).toHaveLength(2);
      expect(first.body.data.hasMore).toBe(true);
      // The whole point: the count describes the filter, not the page.
      expect(first.body.data.total).toBe(6);

      const second = await ctx
        .http()
        .get(`/api/v1/leads?search=PageCo&limit=2&cursor=${first.body.data.nextCursor}`)
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const firstIds = (first.body.data.items as { id: string }[]).map((lead) => lead.id);
      const secondIds = (second.body.data.items as { id: string }[]).map((lead) => lead.id);

      expect(second.body.data.total).toBe(6);
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    });

    it('caps the page size a client can ask for', async () => {
      await ctx
        .http()
        .get('/api/v1/leads?limit=5000')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Dashboard aggregation
  // ---------------------------------------------------------------------------

  describe('dashboard', () => {
    it('counts the whole dataset, not one page', async () => {
      const rows = Array.from(
        { length: 5 },
        (_, index) => `Dash${index},${mobile()},DashCo,1000`,
      ).join('\n');

      const before = await ctx
        .http()
        .get('/api/v1/dashboard')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          csv: `firstName,mobile,companyName,estimatedValue\n${rows}`,
          defaultNextFollowUpAt: inDays(3),
        })
        .expect(200);

      const after = await ctx
        .http()
        .get('/api/v1/dashboard')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(after.body.data.pipeline.activeCount).toBe(
        before.body.data.pipeline.activeCount + 5,
      );
      expect(Number(after.body.data.pipeline.activeValue)).toBe(
        Number(before.body.data.pipeline.activeValue) + 5000,
      );
    });

    it('reports figures for the caller’s organization only', async () => {
      const orgA = await ctx
        .http()
        .get('/api/v1/dashboard')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      const orgB = await ctx
        .http()
        .get('/api/v1/dashboard')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      // Org A has had a file imported into it; Org B has one seeded lead.
      expect(orgA.body.data.pipeline.activeCount).toBeGreaterThan(
        orgB.body.data.pipeline.activeCount,
      );
      expect(orgB.body.data.pipeline.activeCount).toBe(1);
    });

    it('narrows a sales rep to their own pipeline', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/dashboard')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(200);

      // Everything imported above was left unassigned, so a rep holding only
      // lead.view.own must not see it in their totals.
      expect(response.body.data.scope).toBe('OWN');

      const owner = await ctx
        .http()
        .get('/api/v1/dashboard')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      expect(owner.body.data.scope).toBe('ALL');
      expect(response.body.data.pipeline.activeCount).toBeLessThan(
        owner.body.data.pipeline.activeCount,
      );
    });

    it('states the organization timezone it bucketed by', async () => {
      const response = await ctx
        .http()
        .get('/api/v1/dashboard')
        .set(auth(ctx.orgA.owner.accessToken))
        .expect(200);

      // Buckets computed in the browser used the viewer's clock, so a manager
      // travelling saw a different "today" from the team they manage.
      expect(typeof response.body.data.timezone).toBe('string');
      expect(response.body.data.timezone.length).toBeGreaterThan(0);
    });

    it('refuses an unauthenticated request', async () => {
      await ctx.http().get('/api/v1/dashboard').expect(401);
    });
  });
});
