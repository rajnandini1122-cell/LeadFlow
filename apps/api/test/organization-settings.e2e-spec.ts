import {
  createTestContext,
  PASSWORD,
  registerVerifiedOrganization,
  type TestContext,
} from './helpers/test-app';

/**
 * Organization settings — every editable field, end to end.
 *
 * These exist because the settings screen had fields that looked editable and
 * were not, and fields the tenant genuinely needs that were absent altogether.
 * Timezone decides what "today" means in every report; country decides how a
 * phone number is canonicalised, and therefore whether two enquiries from the
 * same person are recognised as duplicates. A tenant that cannot set them is
 * running on somebody else's defaults.
 */
describe('Organization settings', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  /** A fresh organization, so edits here cannot disturb another test. */
  const freshOrg = async (): Promise<{ token: string; organizationId: string }> => {
    const created = await registerVerifiedOrganization(ctx.app, {
      organizationName: `Settings ${unique('org')}`,
      email: `${unique('founder')}@example.test`,
      password: PASSWORD,
      firstName: 'Sam',
      lastName: 'Settings',
    });

    return {
      token: created.tokens.accessToken as string,
      organizationId: created.registration.body.data.user.organization.id as string,
    };
  };

  const patch = (token: string, body: Record<string, unknown>) =>
    ctx.http().patch('/api/v1/organizations/current').set(auth(token)).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Every editable field actually persists
  // ---------------------------------------------------------------------------

  describe('editable fields', () => {
    it('saves the organization name', async () => {
      const org = await freshOrg();
      const response = await patch(org.token, { name: 'Renamed Ltd' }).expect(200);
      expect(response.body.data.name).toBe('Renamed Ltd');
    });

    it('saves the timezone', async () => {
      const org = await freshOrg();

      const response = await patch(org.token, { timezone: 'Europe/Berlin' }).expect(200);
      expect(response.body.data.timezone).toBe('Europe/Berlin');

      // And it takes effect: reports bucket days in this zone.
      const reports = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=today')
        .set(auth(org.token))
        .expect(200);

      expect(reports.body.data.range.timezone).toBe('Europe/Berlin');
    });

    it('saves a timezone with no slash', async () => {
      const org = await freshOrg();
      // The regex this replaced required exactly one separator, so a tenant on
      // UTC could not save their own settings.
      const response = await patch(org.token, { timezone: 'UTC' }).expect(200);
      expect(response.body.data.timezone).toBe('UTC');
    });

    it('saves a timezone with two slashes', async () => {
      const org = await freshOrg();
      const response = await patch(org.token, {
        timezone: 'America/Argentina/Buenos_Aires',
      }).expect(200);
      expect(response.body.data.timezone).toBe('America/Argentina/Buenos_Aires');
    });

    it('saves the currency', async () => {
      const org = await freshOrg();
      const response = await patch(org.token, { currency: 'GBP' }).expect(200);
      expect(response.body.data.currency).toBe('GBP');
    });

    it('saves the locale', async () => {
      const org = await freshOrg();
      const response = await patch(org.token, { locale: 'de-DE' }).expect(200);
      expect(response.body.data.locale).toBe('de-DE');
    });

    it('saves the country', async () => {
      const org = await freshOrg();
      const response = await patch(org.token, { country: 'GB' }).expect(200);
      expect(response.body.data.country).toBe('GB');
    });

    it('saves the lead source list', async () => {
      const org = await freshOrg();

      const response = await patch(org.token, {
        settings: { leadSources: ['Referral', 'Trade show', 'Website'] },
      }).expect(200);

      expect(response.body.data.settings.leadSources).toEqual([
        'Referral',
        'Trade show',
        'Website',
      ]);
    });

    it('saves the follow-up rules', async () => {
      const org = await freshOrg();

      const response = await patch(org.token, {
        settings: {
          followupReminderMinutes: 45,
          followupOverdueMinutes: 240,
          escalateToManager: true,
          workingHoursStart: '08:00',
          workingHoursEnd: '17:00',
        },
      }).expect(200);

      expect(response.body.data.settings.followupReminderMinutes).toBe(45);
      expect(response.body.data.settings.followupOverdueMinutes).toBe(240);
      expect(response.body.data.settings.escalateToManager).toBe(true);
      expect(response.body.data.settings.workingHoursStart).toBe('08:00');
    });

    it('saves everything at once and reads it back', async () => {
      const org = await freshOrg();

      await patch(org.token, {
        name: 'Everything Ltd',
        timezone: 'Asia/Tokyo',
        currency: 'JPY',
        locale: 'ja-JP',
        country: 'JP',
        settings: { followupReminderMinutes: 15, leadSources: ['Inbound'] },
      }).expect(200);

      const reread = await ctx
        .http()
        .get('/api/v1/organizations/current')
        .set(auth(org.token))
        .expect(200);

      expect(reread.body.data).toMatchObject({
        name: 'Everything Ltd',
        timezone: 'Asia/Tokyo',
        currency: 'JPY',
        locale: 'ja-JP',
        country: 'JP',
      });
      expect(reread.body.data.settings.followupReminderMinutes).toBe(15);
      expect(reread.body.data.settings.leadSources).toEqual(['Inbound']);
    });

    it('leaves untouched fields alone', async () => {
      const org = await freshOrg();

      await patch(org.token, { currency: 'EUR', locale: 'de-DE' }).expect(200);
      const response = await patch(org.token, { name: 'Only The Name' }).expect(200);

      // PATCH semantics: an absent field is "not mentioned", not "clear it".
      expect(response.body.data.currency).toBe('EUR');
      expect(response.body.data.locale).toBe('de-DE');
      expect(response.body.data.name).toBe('Only The Name');
    });
  });

  // ---------------------------------------------------------------------------
  // Country actually drives phone canonicalisation
  // ---------------------------------------------------------------------------

  describe('country changes how phone numbers are read', () => {
    it('canonicalises a local number using the organization country', async () => {
      const org = await freshOrg();
      await patch(org.token, { country: 'GB' }).expect(200);

      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(org.token))
        .send({
          firstName: 'Local',
          mobile: '020 7946 0958',
          nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201);

      // The same digits mean different numbers in different countries, and
      // getting this wrong silently breaks duplicate detection, which is built
      // entirely on the canonical form.
      expect(lead.body.data.mobile).toBe('+442079460958');
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  describe('validation', () => {
    it.each([
      ['an unreal timezone', { timezone: 'Mars/Olympus_Mons' }],
      ['a made-up currency', { currency: 'ZZZ' }],
      ['a malformed locale', { locale: 'not a locale' }],
      ['the unknown-region country code', { country: 'ZZ' }],
      ['a three-letter country', { country: 'USA' }],
      ['an empty name', { name: '' }],
      ['a negative reminder', { settings: { followupReminderMinutes: -5 } }],
      ['a malformed working hour', { settings: { workingHoursStart: '25:00' } }],
    ])('rejects %s', async (_label, body) => {
      const org = await freshOrg();
      await patch(org.token, body).expect(400);
    });

    it('normalises a lowercase currency or country rather than refusing it', async () => {
      const org = await freshOrg();

      // The tenant plainly meant USD and GB. Refusing on case would be
      // pedantry; storing them un-normalised would break every comparison.
      const response = await patch(org.token, { currency: 'usd', country: 'gb' }).expect(200);

      expect(response.body.data.currency).toBe('USD');
      expect(response.body.data.country).toBe('GB');
    });

    it('trims and de-duplicates lead sources', async () => {
      const org = await freshOrg();

      const response = await patch(org.token, {
        settings: { leadSources: ['  Referral ', 'Referral', 'Website', '   '] },
      }).expect(200);

      // Otherwise "Referral" and "Referral " both appear in the dropdown as
      // apparently different options.
      expect(response.body.data.settings.leadSources).toEqual(['Referral', 'Website']);
    });

    it('rejects an unknown field rather than silently dropping it', async () => {
      const org = await freshOrg();
      await patch(org.token, { slug: 'hijacked-slug' }).expect(400);
    });

    it('leaves the record untouched when validation fails', async () => {
      const org = await freshOrg();
      const before = await ctx
        .http()
        .get('/api/v1/organizations/current')
        .set(auth(org.token))
        .expect(200);

      // A valid name alongside an invalid currency must save neither.
      await patch(org.token, { name: 'Should Not Save', currency: 'ZZZ' }).expect(400);

      const after = await ctx
        .http()
        .get('/api/v1/organizations/current')
        .set(auth(org.token))
        .expect(200);

      expect(after.body.data.name).toBe(before.body.data.name);
    });
  });

  // ---------------------------------------------------------------------------
  // Authorization and tenant isolation
  // ---------------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses a sales rep', async () => {
      await ctx
        .http()
        .patch('/api/v1/organizations/current')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({ name: 'Rep Was Here' })
        .expect(403);
    });

    it('refuses an unauthenticated caller', async () => {
      await ctx
        .http()
        .patch('/api/v1/organizations/current')
        .send({ name: 'Anonymous Was Here' })
        .expect(401);
    });

    it('edits only the caller’s own organization', async () => {
      const org = await freshOrg();

      await patch(org.token, { name: 'Mine Only', currency: 'CAD' }).expect(200);

      const other = await ctx
        .http()
        .get('/api/v1/organizations/current')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      // There is no id parameter to tamper with — the organization comes from
      // the token — but this proves the write did not spill.
      expect(other.body.data.name).not.toBe('Mine Only');
      expect(other.body.data.currency).not.toBe('CAD');
    });

    it('records the change in the audit trail', async () => {
      const org = await freshOrg();
      await patch(org.token, { timezone: 'Europe/Paris', currency: 'EUR' }).expect(200);

      const audit = await ctx
        .http()
        .get('/api/v1/organizations/audit?limit=20')
        .set(auth(org.token))
        .expect(200);

      const entry = (
        audit.body.data.items as { action: string; after: Record<string, unknown> | null }[]
      ).find((row) => row.action === 'organization.updated');

      expect(entry?.after?.['timezone']).toBe('Europe/Paris');
      expect(entry?.after?.['currency']).toBe('EUR');
    });
  });
});
