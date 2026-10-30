import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * A lead's full address and additional phones / emails.
 *
 * Production, 2026-10-30: a salesperson editing Pallavi Spices could not save.
 * There was nowhere for the office landline, a second mobile or a second email
 * (they went into "Product interest"), nowhere for a street address (it went
 * into "City"), and the email field said "must be a valid email address" for
 * an address that looked right — pasted text carries characters nobody can see.
 */
describe('Lead contact details', () => {
  let ctx: TestContext;

  const owner = () => ({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` });
  const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();

  // Unique per run: emails are a duplicate key across the organization.
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const mail = (local: string): string => `${local}-${uniq}@pallavisspices.test`;

  const createLead = async (body: Record<string, unknown> = {}): Promise<string> =>
    (
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Pallavi', mobile: fixtureMobile(), nextFollowUpAt: inDays(1), ...body })
        .expect(201)
    ).body.data.id as string;

  const edit = (id: string, body: Record<string, unknown>) =>
    ctx.http().patch(`/api/v1/leads/${id}`).set(owner()).send(body);

  const detail = async (id: string) =>
    (await ctx.http().get(`/api/v1/leads/${id}`).set(owner()).expect(200)).body.data as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestContext();
    /*
     * Numbers are read in the organization's country, exactly as `mobile` is.
     * Every production organization is IN (checked 2026-10-30), where
     * "020-29512009" is a Pune landline; set the same here so the local
     * formats a salesperson actually types are what is tested.
     */
    await ctx.app.get(TenantContextService).runAsSystem('e2e: org country', () =>
      ctx.app.get(PrismaService).client.organization.update({
        where: { id: ctx.orgA.id },
        data: { country: 'IN' },
      }),
    );
  });
  afterAll(async () => {
    await ctx?.close();
  });

  describe('the edit that failed in production, done properly', () => {
    it('stores a full address and additional phones and emails', async () => {
      const id = await createLead();

      await edit(id, {
        lastName: 'Rasal',
        email: mail('sales'),
        companyName: 'Pallavi Spices and Foods',
        addressLine1: 'Survey No. 68, Jambhulwadi–Kolewadi Road',
        addressLine2: 'Jambhulwadi',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411046',
        additionalPhones: ['020-29512009', '+91 98230 55636'],
        additionalEmails: [mail('PallavisSpices')],
        productInterest: 'Turmeric and chilli powder',
        priority: 'HIGH',
      }).expect(200);

      const lead = await detail(id);
      expect(lead).toMatchObject({
        addressLine1: 'Survey No. 68, Jambhulwadi–Kolewadi Road',
        addressLine2: 'Jambhulwadi',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411046',
        // E.164 against the tenant's country, like the primary mobile.
        additionalPhones: ['+912029512009', '+919823055636'],
        // Lower-cased, like the primary email.
        additionalEmails: [mail('pallavisspices')],
        productInterest: 'Turmeric and chilli powder',
      });
    });

    it('returns empty lists, not null, for a lead that has none', async () => {
      const lead = await detail(await createLead());
      expect(lead['additionalPhones']).toEqual([]);
      expect(lead['additionalEmails']).toEqual([]);
    });
  });

  describe('pasted email addresses', () => {
    it.each([
      ['a trailing full stop', `${mail('dot')}.`, mail('dot')],
      ['a trailing comma', `${mail('comma')},`, mail('comma')],
      ['a mailto: prefix', `mailto:${mail('link')}`, mail('link')],
      ['a full-width \uff20 from a phone keyboard', mail('wide').replace('@', '\uff20'), mail('wide')],
      ['a zero-width space', `${mail('zw')}\u200b`, mail('zw')],
      ['a no-break space', `\u00a0${mail('nbsp')}`, mail('nbsp')],
      ['a left-to-right mark', `\u200e${mail('ltr')}`, mail('ltr')],
    ])('cleans %s and stores the real address', async (_label, typed, stored) => {
      const id = await createLead();
      await edit(id, { email: typed }).expect(200);
      expect((await detail(id))['email']).toBe(stored);
    });

    it('cleans additional emails the same way, dropping repeats', async () => {
      const id = await createLead();
      await edit(id, {
        additionalEmails: [`${mail('acc')}.`, `mailto:${mail('ACC')}`, `\u200b${mail('buy')}`],
      }).expect(200);
      expect((await detail(id))['additionalEmails']).toEqual([mail('acc'), mail('buy')]);
    });

    it('still refuses what is genuinely wrong, naming the field', async () => {
      const id = await createLead();
      const twoInOne = await edit(id, { email: `${mail('one')}, ${mail('two')}` }).expect(400);
      expect(twoInOne.body.error.details.email).toEqual(['must be a valid email address']);

      const badExtra = await edit(id, { additionalEmails: ['not-an-email'] }).expect(400);
      expect(badExtra.body.error.details.additionalEmails).toBeDefined();
    });
  });

  describe('additional phones', () => {
    it('refuses an unreadable number, saying which one', async () => {
      const id = await createLead();
      const res = await edit(id, { additionalPhones: ['020-29512009', '12345'] }).expect(400);
      expect(res.body.error.details.additionalPhones[0]).toMatch(/12345/);
    });

    it('drops repeats and the primary mobile itself', async () => {
      const primary = fixtureMobile();
      const id = await createLead({ mobile: primary });
      await edit(id, { additionalPhones: [primary, '020-29512009', '020 2951 2009'] }).expect(200);
      expect((await detail(id))['additionalPhones']).toEqual(['+912029512009']);
    });

    it('holds at most five of each', async () => {
      const id = await createLead();
      await edit(id, {
        additionalPhones: ['02029512001', '02029512002', '02029512003', '02029512004', '02029512005', '02029512006'],
      }).expect(400);
      await edit(id, { additionalEmails: [1, 2, 3, 4, 5, 6].map((n) => mail(`x${n}`)) }).expect(400);
    });
  });

  describe('clearing', () => {
    it('clears address fields with null and lists with []', async () => {
      const id = await createLead({ city: 'Pune', addressLine1: 'Plot 4', additionalPhones: ['020-29512009'] });
      await edit(id, { city: null, addressLine1: '', additionalPhones: [] }).expect(200);
      const lead = await detail(id);
      expect(lead['city']).toBeNull();
      expect(lead['addressLine1']).toBeNull();
      expect(lead['additionalPhones']).toEqual([]);
    });

    it('leaves fields it was not sent alone', async () => {
      const id = await createLead({ city: 'Pune', additionalEmails: [mail('keep')] });
      await edit(id, { priority: 'HIGH' }).expect(200);
      const lead = await detail(id);
      expect(lead['city']).toBe('Pune');
      expect(lead['additionalEmails']).toEqual([mail('keep')]);
    });
  });

  describe("another lead's email or mobile", () => {
    it('answers 409 naming the other lead — not a 500 with server internals', async () => {
      const taken = mail('taken');
      await createLead({ email: taken });
      const id = await createLead();

      const res = await edit(id, { email: taken });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_LEAD');
      expect(res.body.error.message).toMatch(/Another lead already has this email address/);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|\.ts|Invalid `/i);
    });
  });

  describe('creating a lead', () => {
    it('accepts the full address and additional contacts', async () => {
      const id = await createLead({
        email: mail('new'),
        addressLine1: 'Survey No. 68',
        state: 'Maharashtra',
        postalCode: '411046',
        additionalPhones: ['020-29512009'],
        additionalEmails: [mail('new'), mail('accounts')],
      });
      expect(await detail(id)).toMatchObject({
        addressLine1: 'Survey No. 68',
        state: 'Maharashtra',
        postalCode: '411046',
        additionalPhones: ['+912029512009'],
        // The primary address is not repeated as an "additional" one.
        additionalEmails: [mail('accounts')],
      });
    });
  });

  describe('search', () => {
    it('finds a lead by an additional phone, typed the way people type it', async () => {
      const id = await createLead({ additionalPhones: ['020-29512788'] });
      const res = await ctx.http().get('/api/v1/leads').query({ search: '020 2951 2788' }).set(owner()).expect(200);
      expect((res.body.data.items as { id: string }[]).map((l) => l.id)).toContain(id);
    });

    it('finds a lead by an additional email', async () => {
      const extra = mail('findme');
      const id = await createLead({ additionalEmails: [extra] });
      const res = await ctx.http().get('/api/v1/leads').query({ search: extra.toUpperCase() }).set(owner()).expect(200);
      expect((res.body.data.items as { id: string }[]).map((l) => l.id)).toContain(id);
    });
  });

  describe('designation', () => {
    it('is stored on create, changed on edit and cleared with a blank', async () => {
      const id = await createLead({ lastName: 'Rasal', designation: '  Purchase Manager ' });
      expect((await detail(id))['designation']).toBe('Purchase Manager');

      await edit(id, { designation: 'Proprietor' }).expect(200);
      expect((await detail(id))['designation']).toBe('Proprietor');

      await edit(id, { designation: '' }).expect(200);
      expect((await detail(id))['designation']).toBeNull();
    });

    it('refuses an over-long designation, naming the field', async () => {
      const id = await createLead();
      const res = await edit(id, { designation: 'x'.repeat(101) }).expect(400);
      expect(res.body.error.details.designation).toBeDefined();
    });
  });

  /*
   * "Rescheduling with a comment throws an error" (production, 2026-10-30):
   * five 400s on one lead within 20 seconds from the Schedule follow-up dialog,
   * whose only text box — a 200-character label — had been used for the
   * comment. The comment now has its own field, and both show on the timeline.
   */
  describe('follow-up comments', () => {
    const timeline = async (leadId: string): Promise<string[]> =>
      (
        (await ctx.http().get(`/api/v1/leads/${leadId}/activities`).set(owner()).expect(200)).body.data
          .items as { description: string | null }[]
      ).map((a) => a.description ?? '');

    it('saves a long comment and shows it on the timeline', async () => {
      const id = await createLead();
      const comment = 'Customer asked to call after Diwali; wants 2 kg turmeric samples first. '.repeat(5).trim();

      await ctx
        .http()
        .post(`/api/v1/leads/${id}/follow-ups`)
        .set(owner())
        .send({ scheduledAt: inDays(3), type: 'CALL', title: 'Send revised quotation', notes: comment })
        .expect(201);

      const entry = (await timeline(id)).find((d) => d.startsWith('Follow-up scheduled for'));
      expect(entry).toContain('— Send revised quotation: Customer asked to call after Diwali');
    });

    it('rejects an over-long LABEL with an error on that field, not a bare "validation failed"', async () => {
      const id = await createLead();
      const res = await ctx
        .http()
        .post(`/api/v1/leads/${id}/follow-ups`)
        .set(owner())
        .send({ scheduledAt: inDays(3), title: 'x'.repeat(201) })
        .expect(400);
      expect(res.body.error.details.title).toBeDefined();
    });

    it('puts a reschedule reason on the timeline with the old and new time', async () => {
      const id = await createLead({ assignedToId: ctx.orgA.owner.id });
      const open = (
        (await ctx.http().get(`/api/v1/leads/${id}/follow-ups`).set(owner()).expect(200)).body.data as {
          id: string;
          status: string;
        }[]
      ).find((f) => ['UPCOMING', 'DUE', 'OVERDUE'].includes(f.status));

      await ctx
        .http()
        .post(`/api/v1/follow-ups/${open?.id}/reschedule`)
        .set(owner())
        .send({ scheduledAt: inDays(4), reason: 'Customer travelling, call Monday' })
        .expect((r) => expect([200, 201]).toContain(r.status));

      expect((await timeline(id)).some((d) => /^Rescheduled from .+ — Customer travelling, call Monday$/.test(d))).toBe(true);
    });
  });
});
