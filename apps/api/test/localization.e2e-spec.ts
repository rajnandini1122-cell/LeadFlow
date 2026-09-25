import {
  createTestContext,
  PASSWORD,
  registerVerifiedOrganization,
  type TestContext,
} from './helpers/test-app';
import { fixtureMobile, toFixtureE164 } from './helpers/phone-fixtures';

/**
 * Country, locale and phone, end to end.
 *
 * Two failures sit behind every case here, and both are silent.
 *
 * The first is a tenant created with settings nobody chose. Registration used
 * to validate country, timezone and currency by LENGTH alone, so "ZZ", "xyz"
 * and "zzz" were all accepted — and the schema's own US/UTC/USD defaults
 * applied to anything omitted, in a product that sells in India.
 *
 * The second is the same customer stored twice. A phone number is the key
 * duplicate detection compares on, so "9876543210", "+91 98765 43210" and
 * "919876543210" have to become one value — and a number that merely LOOKS
 * prefixed must not be mutilated into a different one on the way.
 */
describe('Country, locale and phone', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;
  const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString();

  const registrationPayload = (overrides: Record<string, unknown> = {}) => ({
    organizationName: `Locale ${unique('org')}`,
    email: `${unique('founder')}@example.test`,
    password: PASSWORD,
    firstName: 'Priya',
    lastName: 'Sharma',
    ...overrides,
  });

  /** Registers a brand-new organization and returns what it was created with. */
  const register = async (overrides: Record<string, unknown> = {}) =>
    ctx.http().post('/api/v1/auth/register').send(registrationPayload(overrides));

  /**
   * Registers and signs in.
   *
   * Registration alone no longer yields a token — the mailbox has to be proven
   * first — and every test below this line is about phone and currency
   * formatting, not about verification.
   */
  const registerSignedIn = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const result = await registerVerifiedOrganization(ctx.app, registrationPayload(overrides));
    return result.tokens.accessToken;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // Registration — where a tenant's identity is decided
  // ---------------------------------------------------------------------------

  describe('a new organization', () => {
    it('takes the configured deployment defaults when the founder says nothing', async () => {
      const response = await register();
      expect(response.status).toBe(201);

      /*
       * India, because that is what this deployment is configured for — NOT
       * the US/UTC/USD/en-US in the Prisma column defaults, which are simply
       * what the first migration happened to write and are never what decides
       * a tenant.
       */
      expect(response.body.data.user.organization).toMatchObject({
        country: 'IN',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        locale: 'en-IN',
      });
    });

    it('honours what the founder actually chose', async () => {
      const response = await register({
        country: 'DE',
        timezone: 'Europe/Berlin',
        currency: 'EUR',
        locale: 'de-DE',
      });

      expect(response.status).toBe(201);
      expect(response.body.data.user.organization).toMatchObject({
        country: 'DE',
        timezone: 'Europe/Berlin',
        currency: 'EUR',
        locale: 'de-DE',
      });
    });

    it('corrects the case of what they typed', async () => {
      // "in" and "inr" are what a form posts; IN and INR are what every
      // comparison elsewhere expects.
      const response = await register({ country: 'in', currency: 'inr', locale: 'en-in' });

      expect(response.status).toBe(201);
      expect(response.body.data.user.organization).toMatchObject({
        country: 'IN',
        currency: 'INR',
        locale: 'en-IN',
      });
    });

    it.each([
      ['country', 'ZZ'],
      ['country', 'IND'],
      ['country', 'India'],
      ['country', '1'],
      ['timezone', 'IST'],
      ['timezone', 'India'],
      ['timezone', 'GMT+5:30'],
      ['timezone', 'xyz'],
      ['currency', 'ZZZ'],
      ['currency', 'rupee'],
      ['locale', 'en_IN'],
      ['locale', 'not a locale'],
    ])('REFUSES to create a tenant with %s=%s', async (field, value) => {
      /*
       * Each of these used to be accepted. The damage is quiet: a tenant in
       * country ZZ reads every local phone number as unparseable, a tenant on
       * timezone "xyz" has no working definition of "today", and neither shows
       * a single error until somebody notices the follow-ups are wrong.
       */
      const response = await register({ [field]: value });

      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Phone canonicalisation across the CRM
  // ---------------------------------------------------------------------------

  describe('phone numbers are stored one way', () => {
    /** An organization in India, so local numbers resolve to +91. */
    const indianOrg = async () => registerSignedIn({ country: 'IN' });

    it('canonicalises a local number on a LEAD, using the tenant country', async () => {
      const token = await indianOrg();

      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(token))
        .send({ firstName: 'Anil', mobile: '9876543210', nextFollowUpAt: tomorrow() })
        .expect(201);

      expect(lead.body.data.mobile).toBe('+919876543210');
    });

    it('maps every spelling of one number onto one stored value', async () => {
      const token = await indianOrg();

      const stored = [];
      for (const [index, spelling] of ['+91 98765 43211', '098765 43211', '919876543211'].entries()) {
        const lead = await ctx
          .http()
          .post('/api/v1/leads')
          .set(auth(token))
          .send({
            firstName: `Spelling ${index}`,
            mobile: spelling,
            nextFollowUpAt: tomorrow(),
            // Each is deliberately the same customer; the point is the stored
            // form, not the duplicate rule, so the choice is acknowledged.
            allowDuplicate: true,
          });

        if (lead.status === 201) stored.push(lead.body.data.mobile);
      }

      expect(new Set(stored)).toEqual(new Set(['+919876543211']));
    });

    it('does NOT mangle a mobile that merely begins with the country code', async () => {
      const token = await indianOrg();

      /*
       * The bug this whole change removes. The previous parser cut "91" off
       * any national number starting with it, so this real ten-digit mobile
       * was stored as +9187654321 — a different number, belonging to nobody.
       */
      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(token))
        .send({ firstName: 'Ninety', mobile: '9187654321', nextFollowUpAt: tomorrow() })
        .expect(201);

      expect(lead.body.data.mobile).toBe('+919187654321');
    });

    it('keeps an explicitly international number in its own country', async () => {
      const token = await indianOrg();

      // A UK customer of an Indian tenant stays a UK customer.
      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(token))
        .send({ firstName: 'Nigel', mobile: '+44 7911 123456', nextFollowUpAt: tomorrow() })
        .expect(201);

      expect(lead.body.data.mobile).toBe('+447911123456');
    });

    it('refuses a number that could not be dialled', async () => {
      const token = await indianOrg();

      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(token))
        .send({ firstName: 'Wrong', mobile: '12345', nextFollowUpAt: tomorrow() });

      // Rejected, not quietly stored as null: a customer record with no way to
      // reach the customer is discovered by the salesperson who cannot call.
      expect(response.status).toBe(400);
    });

    it('canonicalises a CONTACT on create and on update alike', async () => {
      const token = await indianOrg();

      const created = await ctx
        .http()
        .post('/api/v1/contacts')
        .set(auth(token))
        .send({ firstName: 'Meera', mobile: '9876500011' })
        .expect(201);

      expect(created.body.data.mobile).toBe('+919876500011');

      const updated = await ctx
        .http()
        .patch(`/api/v1/contacts/${created.body.data.id}`)
        .set(auth(token))
        .send({ mobile: '098765 00012' })
        .expect(200);

      // The same rule on both paths. A record that canonicalises one way when
      // created and another when edited disagrees with itself about who it is.
      expect(updated.body.data.mobile).toBe('+919876500012');
    });

    it('canonicalises an ACCOUNT phone on create and on update alike', async () => {
      const token = await indianOrg();

      const created = await ctx
        .http()
        .post('/api/v1/accounts')
        .set(auth(token))
        .send({ name: `Kestrel ${unique('acc')}`, phone: '9876500021' })
        .expect(201);

      // create answers with the account AND what it thought were duplicates.
      expect(created.body.data.account.phone).toBe('+919876500021');

      const updated = await ctx
        .http()
        .patch(`/api/v1/accounts/${created.body.data.account.id}`)
        .set(auth(token))
        .send({ phone: '+91 98765 00022' })
        .expect(200);

      expect(updated.body.data.phone).toBe('+919876500022');
    });

    it('canonicalises a colleague’s own mobile when they are invited', async () => {
      const token = await indianOrg();

      const invite = await ctx
        .http()
        .post('/api/v1/users/invite')
        .set(auth(token))
        .send({
          email: `${unique('colleague')}@example.test`,
          fullName: 'Ravi Kumar',
          role: 'SALES_REP',
          mobile: '9876500031',
        })
        .expect(201);

      const members = await ctx.http().get('/api/v1/users').set(auth(token)).expect(200);
      const invited = (members.body.data as { id: string; mobile: string | null }[]).find(
        (member) => member.id === invite.body.data.userId,
      );

      // The one column holding a salesperson's number should not be the only
      // one in the database written however somebody typed it.
      expect(invited?.mobile).toBe('+919876500031');
    });

    it('applies the tenant country, not a hardcoded one', async () => {
      // The same digits in a US tenant are a US number. If a default leaked
      // into the parser, this would come back as +91.
      const token = await registerSignedIn({ country: 'US' });
      const national = fixtureMobile();

      const lead = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(token))
        .send({ firstName: 'Pat', mobile: national, nextFollowUpAt: tomorrow() })
        .expect(201);

      expect(lead.body.data.mobile).toBe(toFixtureE164(national));
    });
  });

  // ---------------------------------------------------------------------------
  // The public contact form — a stranger, not a tenant
  // ---------------------------------------------------------------------------

  describe('a public enquiry', () => {
    const enquiry = (overrides: Record<string, unknown> = {}) => ({
      name: 'Dana Whitfield',
      email: `${unique('buyer')}@example.test`,
      message: 'We are a team of six and want to stop losing enquiries. Can we see a demo?',
      ...overrides,
    });

    beforeEach(() => {
      // The form allows five an hour per address and every case here arrives
      // from the same loopback address.
      ctx.redis.flush();
    });

    it('keeps a foreign number foreign', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/contact')
        .send(enquiry({ phone: '+49 151 12345678', country: 'DE' }))
        .expect(200);

      expect(response.body.data.reference).toMatch(/^[0-9A-F]{8}$/);
    });

    it('accepts an enquiry whose number cannot be parsed at all', async () => {
      /*
       * Deliberately gentler than every CRM path. This is a person on a public
       * page who may never come back, and the message, the name and the email
       * are what sales actually needs — an unusable phone number is not worth
       * refusing a customer over.
       */
      await ctx
        .http()
        .post('/api/v1/contact')
        .send(enquiry({ phone: 'call me on whatsapp' }))
        .expect(200);
    });

    it('still refuses a country code that is not a country', async () => {
      await ctx.http().post('/api/v1/contact').send(enquiry({ country: 'ZZ' })).expect(400);
    });

    it('cannot be redirected by anything in the payload', async () => {
      // Normalising a phone number must not have opened a door to setting
      // fields the form does not offer. A destination the caller invents is
      // refused outright rather than ignored.
      for (const field of ['to', 'salesEmail', 'notifyEmail']) {
        ctx.redis.flush();
        await ctx
          .http()
          .post('/api/v1/contact')
          .send(enquiry({ [field]: 'attacker@example.test' }))
          .expect(400);
      }
    });

    it('ignores a tenant id rather than obeying one', async () => {
      /*
       * organizationId is STRIPPED by the global interceptor before validation
       * reaches it, which is why this is a 200 and not a 400 — the field never
       * exists by the time anything could act on it. An enquiry belongs to no
       * tenant at all; the column does not exist on the table.
       */
      ctx.redis.flush();
      await ctx
        .http()
        .post('/api/v1/contact')
        .send(enquiry({ organizationId: ctx.orgB.id, phone: '+91 98765 43210' }))
        .expect(200);
    });
  });
});
