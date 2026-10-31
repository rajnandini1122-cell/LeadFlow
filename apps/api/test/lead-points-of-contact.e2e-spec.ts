import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Several points of contact (POCs) per lead: the purchase manager who asks,
 * the accounts person who pays, the owner who signs off.
 */
describe('Lead points of contact', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const rep = () => auth(ctx.orgA.rep.accessToken);
  const otherOrg = () => auth(ctx.orgB.owner.accessToken);
  const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const mail = (local: string): string => `${local}-${uniq}@poc.test`;

  type Poc = {
    id: string;
    contactId: string;
    name: string;
    isPrimary: boolean;
    active: boolean;
    mobile: string | null;
    whatsapp: string | null;
    email: string | null;
    designation: string | null;
    department: string | null;
  };

  const createLead = (body: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({
        firstName: 'Ravi',
        companyName: 'Acme Foods',
        mobile: fixtureMobile(),
        nextFollowUpAt: inDays(1),
        ...body,
      });

  const newLeadId = async (body: Record<string, unknown> = {}): Promise<string> =>
    (await createLead(body).expect(201)).body.data.id as string;

  const pocs = async (leadId: string, headers = owner()): Promise<Poc[]> =>
    (await ctx.http().get(`/api/v1/leads/${leadId}/contacts`).set(headers).expect(200)).body
      .data as Poc[];

  const add = (leadId: string, body: Record<string, unknown>, headers = owner()) =>
    ctx.http().post(`/api/v1/leads/${leadId}/contacts`).set(headers).send(body);

  const primaries = (list: Poc[]) => list.filter((p) => p.isPrimary);

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('a lead and its first contact', () => {
    it('makes the enquirer the primary contact of a new lead', async () => {
      const list = await pocs(
        await newLeadId({ firstName: 'Ravi', designation: 'Purchase Manager' }),
      );
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ name: 'Ravi', isPrimary: true, active: true });
    });

    it.each([1, 2, 5])('creates a lead with %i contact(s) in one request', async (count) => {
      const extras = Array.from({ length: count - 1 }, (_, i) => ({
        firstName: `Person ${i + 2}`,
        designation: 'Accounts',
        department: 'Accounts',
        mobile: fixtureMobile(),
        email: mail(`p${count}-${i}`),
      }));
      const id = await newLeadId({ additionalContacts: extras });
      const list = await pocs(id);
      expect(list).toHaveLength(count);
      expect(primaries(list)).toHaveLength(1);
      expect(list[0]?.name).toBe('Ravi');

      const summary = (await ctx.http().get(`/api/v1/leads/${id}`).set(owner()).expect(200)).body
        .data;
      expect(summary.contactCount).toBe(count);
      expect(summary.primaryContact.name).toBe('Ravi');
    });

    it('lets one of the extra contacts be the primary instead', async () => {
      const id = await newLeadId({
        additionalContacts: [
          { firstName: 'Sunita', designation: 'Owner', isPrimary: true, mobile: fixtureMobile() },
        ],
      });
      const list = await pocs(id);
      expect(primaries(list).map((p) => p.name)).toEqual(['Sunita']);
    });

    it('refuses two primaries, or one person entered twice, before writing anything', async () => {
      const repeated = fixtureMobile();
      const before = await ctx
        .http()
        .get('/api/v1/leads')
        .set(owner())
        .query({ limit: 1 })
        .expect(200);
      await createLead({
        additionalContacts: [
          { firstName: 'A', isPrimary: true },
          { firstName: 'B', isPrimary: true },
        ],
      }).expect(400);
      await createLead({
        mobile: repeated,
        additionalContacts: [{ firstName: 'Twin', mobile: repeated }],
      }).expect(400);
      const after = await ctx
        .http()
        .get('/api/v1/leads')
        .set(owner())
        .query({ limit: 1 })
        .expect(200);
      expect(after.body.data.items[0]?.id).toBe(before.body.data.items[0]?.id);
    });
  });

  describe('managing contacts on an existing lead', () => {
    it('adds, edits, makes primary and deactivates -- always exactly one primary', async () => {
      const id = await newLeadId();
      const added = await add(id, {
        firstName: 'Meera',
        lastName: 'Shah',
        designation: 'Accounts Head',
        department: 'Accounts',
        mobile: fixtureMobile(),
        whatsapp: fixtureMobile(),
        email: mail('meera'),
        notes: 'Pays invoices on Fridays',
      }).expect(201);
      const meera = added.body.data as Poc;
      expect(meera).toMatchObject({ name: 'Meera Shah', isPrimary: false, department: 'Accounts' });
      expect(meera.whatsapp).toMatch(/^\+/);

      await ctx
        .http()
        .patch(`/api/v1/leads/${id}/contacts/${meera.id}`)
        .set(owner())
        .send({ designation: 'CFO' })
        .expect(200);

      let list = (
        await ctx
          .http()
          .post(`/api/v1/leads/${id}/contacts/${meera.id}/primary`)
          .set(owner())
          .expect(200)
      ).body.data as Poc[];
      expect(primaries(list).map((p) => p.name)).toEqual(['Meera Shah']);
      expect(list.find((p) => p.name === 'Meera Shah')?.designation).toBe('CFO');

      // Deactivating the primary hands primary to the longest-standing active one.
      list = (
        await ctx
          .http()
          .post(`/api/v1/leads/${id}/contacts/${meera.id}/deactivate`)
          .set(owner())
          .expect(200)
      ).body.data as Poc[];
      expect(primaries(list).map((p) => p.name)).toEqual(['Ravi']);
      expect(list.find((p) => p.name === 'Meera Shah')).toMatchObject({
        active: false,
        isPrimary: false,
      });

      // An inactive person cannot be made primary.
      await ctx
        .http()
        .post(`/api/v1/leads/${id}/contacts/${meera.id}/primary`)
        .set(owner())
        .expect(400);
      list = (
        await ctx
          .http()
          .post(`/api/v1/leads/${id}/contacts/${meera.id}/reactivate`)
          .set(owner())
          .expect(200)
      ).body.data as Poc[];
      expect(list.find((p) => p.name === 'Meera Shah')).toMatchObject({
        active: true,
        isPrimary: false,
      });
    });

    it('promotes nobody when the last active contact leaves, and restores primary on return', async () => {
      const id = await newLeadId();
      const [only] = await pocs(id);
      let list = (
        await ctx
          .http()
          .post(`/api/v1/leads/${id}/contacts/${only!.id}/deactivate`)
          .set(owner())
          .expect(200)
      ).body.data as Poc[];
      expect(primaries(list)).toHaveLength(0);
      list = (
        await ctx
          .http()
          .post(`/api/v1/leads/${id}/contacts/${only!.id}/reactivate`)
          .set(owner())
          .expect(200)
      ).body.data as Poc[];
      expect(primaries(list).map((p) => p.id)).toEqual([only!.id]);
    });

    it('warns about a matching phone or email at the company, and adds on confirmation', async () => {
      const email = mail('shared-box');
      const id = await newLeadId();
      await add(id, { firstName: 'Kiran', email }).expect(201);

      const warned = await add(id, { firstName: 'Kiran Again', email }).expect(409);
      expect(warned.body.error.code).toBe(ERROR_CODES.DUPLICATE_CONTACT);

      await add(id, { firstName: 'Kiran Again', email, allowDuplicate: true }).expect(201);
      expect(await pocs(id)).toHaveLength(3);
    });

    it('links the existing person for a known phone number instead of copying them', async () => {
      const shared = fixtureMobile();
      const first = await newLeadId();
      const second = await newLeadId();
      const a = (await add(first, { firstName: 'Anil', mobile: shared }).expect(201)).body
        .data as Poc;
      const b = (await add(second, { firstName: 'Anil', mobile: shared }).expect(201)).body
        .data as Poc;
      expect(b.contactId).toBe(a.contactId);

      // ...and refuses to add them to the same lead twice, whatever it is told.
      const again = await add(first, {
        firstName: 'Anil',
        mobile: shared,
        allowDuplicate: true,
      }).expect(409);
      expect(again.body.error.code).toBe(ERROR_CODES.DUPLICATE_CONTACT);
    });

    it('rejects an invalid phone number', async () => {
      await add(await newLeadId(), { firstName: 'Bad', mobile: '12' }).expect(400);
    });
  });

  describe('concurrency', () => {
    it('keeps exactly one primary when several people change it at once', async () => {
      const id = await newLeadId({
        additionalContacts: [1, 2, 3, 4].map((n) => ({
          firstName: `C${n}`,
          mobile: fixtureMobile(),
        })),
      });
      const list = await pocs(id);
      const results = await Promise.all(
        list.map((p) =>
          ctx.http().post(`/api/v1/leads/${id}/contacts/${p.id}/primary`).set(owner()),
        ),
      );
      for (const r of results) expect([200, 409]).toContain(r.status);
      expect(primaries(await pocs(id))).toHaveLength(1);
    });
  });

  describe('tenant isolation and visibility', () => {
    it('hides one organization’s lead contacts from another', async () => {
      const id = await newLeadId();
      const [poc] = await pocs(id);
      await ctx.http().get(`/api/v1/leads/${id}/contacts`).set(otherOrg()).expect(404);
      await add(id, { firstName: 'Intruder' }, otherOrg()).expect(404);
      await ctx
        .http()
        .post(`/api/v1/leads/${id}/contacts/${poc!.id}/primary`)
        .set(otherOrg())
        .expect(404);
      await ctx
        .http()
        .patch(`/api/v1/leads/${id}/contacts/${poc!.id}`)
        .set(otherOrg())
        .send({ firstName: 'X' })
        .expect(404);
    });

    it('applies the lead’s own visibility to a rep who does not own it', async () => {
      const id = await newLeadId();
      await ctx.http().get(`/api/v1/leads/${id}/contacts`).set(rep()).expect(404);
    });

    it('refuses a link id that belongs to another lead', async () => {
      const a = await newLeadId();
      const b = await newLeadId();
      const [pocOfB] = await pocs(b);
      await ctx
        .http()
        .post(`/api/v1/leads/${a}/contacts/${pocOfB!.id}/primary`)
        .set(owner())
        .expect(404);
    });
  });

  describe('search', () => {
    it('finds a lead by a secondary contact’s name, phone and email', async () => {
      const phone = fixtureMobile();
      const email = mail('findme');
      const id = await newLeadId();
      await add(id, { firstName: `Zebulon${uniq}`, mobile: phone, email }).expect(201);

      for (const search of [`Zebulon${uniq}`, email, phone]) {
        const found = await ctx
          .http()
          .get('/api/v1/leads')
          .set(owner())
          .query({ search })
          .expect(200);
        expect((found.body.data.items as { id: string }[]).map((l) => l.id)).toContain(id);
      }
    });

    it('stops finding a lead by a contact once they are inactive', async () => {
      const id = await newLeadId();
      const added = (await add(id, { firstName: `Gone${uniq}` }).expect(201)).body.data as Poc;
      await ctx
        .http()
        .post(`/api/v1/leads/${id}/contacts/${added.id}/deactivate`)
        .set(owner())
        .expect(200);
      const found = await ctx
        .http()
        .get('/api/v1/leads')
        .set(owner())
        .query({ search: `Gone${uniq}` })
        .expect(200);
      expect((found.body.data.items as { id: string }[]).map((l) => l.id)).not.toContain(id);
    });
  });

  describe('sales workflow', () => {
    it('schedules a follow-up with a chosen contact, and refuses someone not on the lead', async () => {
      const id = await newLeadId({ assignedToId: ctx.orgA.owner.id });
      const meera = (await add(id, { firstName: 'Meera', designation: 'Accounts' }).expect(201))
        .body.data as Poc;

      const scheduled = await ctx
        .http()
        .post(`/api/v1/leads/${id}/follow-ups`)
        .set(owner())
        .send({ scheduledAt: inDays(2), type: 'CALL', contactId: meera.contactId })
        .expect(201);
      expect(scheduled.body.data.contact).toMatchObject({ id: meera.contactId, name: 'Meera' });

      const stranger = (await add(await newLeadId(), { firstName: 'Elsewhere' }).expect(201)).body
        .data as Poc;
      await ctx
        .http()
        .post(`/api/v1/leads/${id}/follow-ups`)
        .set(owner())
        .send({ scheduledAt: inDays(2), contactId: stranger.contactId })
        .expect(400);

      const listed = (
        await ctx.http().get(`/api/v1/leads/${id}/follow-ups`).set(owner()).expect(200)
      ).body.data as {
        contact: { name: string } | null;
      }[];
      expect(listed.some((f) => f.contact?.name === 'Meera')).toBe(true);
    });

    it('records who was spoken to on a logged call outcome', async () => {
      const id = await newLeadId({ assignedToId: ctx.orgA.owner.id });
      const meera = (await add(id, { firstName: 'Meera', designation: 'Accounts' }).expect(201))
        .body.data as Poc;

      await ctx
        .http()
        .post(`/api/v1/leads/${id}/outcomes`)
        .set(owner())
        .send({ outcome: 'NOT_ANSWERED', nextFollowUpAt: inDays(1), contactId: meera.contactId })
        .expect(200);

      const timeline = (
        await ctx.http().get(`/api/v1/leads/${id}/activities`).set(owner()).expect(200)
      ).body.data.items as {
        description: string | null;
      }[];
      expect(timeline.some((a) => (a.description ?? '').includes('with Meera, Accounts'))).toBe(
        true,
      );
    });

    it('records the contact on a manually logged activity', async () => {
      const id = await newLeadId();
      const [ravi] = await pocs(id);
      await ctx
        .http()
        .post(`/api/v1/leads/${id}/activities`)
        .set(owner())
        .send({
          activityType: 'WHATSAPP_SENT',
          description: 'Sent price list',
          contactId: ravi!.contactId,
        })
        .expect(201);
      const timeline = (
        await ctx.http().get(`/api/v1/leads/${id}/activities`).set(owner()).expect(200)
      ).body.data.items as {
        description: string | null;
      }[];
      expect(timeline.some((a) => a.description === 'Sent price list — with Ravi')).toBe(true);
    });
  });

  describe('existing data', () => {
    it('gives a legacy lead with a contact but no link its contact as primary on first read', async () => {
      const id = await newLeadId();
      const prisma = ctx.app.get(PrismaService).client;
      await ctx.app
        .get(TenantContextService)
        .runAsSystem('e2e: simulate a lead from the old API', () =>
          prisma.leadContact.deleteMany({ where: { leadId: id } }),
        );
      const list = await pocs(id);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ name: 'Ravi', isPrimary: true });
    });

    it('moves points of contact to the surviving person when two contacts are merged', async () => {
      const id = await newLeadId();
      const extra = (await add(id, { firstName: 'Dup', mobile: fixtureMobile() }).expect(201)).body
        .data as Poc;
      const [enquirer] = await pocs(id);
      await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(owner())
        .send({ sourceId: extra.contactId, targetId: enquirer!.contactId })
        .expect((r) => expect([200, 201]).toContain(r.status));
      const list = await pocs(id);
      expect(list).toHaveLength(1);
      expect(primaries(list)).toHaveLength(1);
    });
  });
});
