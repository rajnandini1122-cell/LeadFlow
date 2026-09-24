import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * What a rejected registration TELLS the person filling in the form.
 *
 * This covers a reported production symptom: the registration page showed
 * "Request validation failed." and highlighted nothing, on a form with six
 * fields. The constraint messages existed, crossed the network, and were then
 * filed under a single key called `_` — which the form, looking up
 * `fieldErrors['password']`, could never match.
 *
 * So these assert the SHAPE of the failure as well as the status. A test that
 * only checked for 400 would have passed throughout the defect.
 *
 * Nothing here loosens validation: every payload below is genuinely invalid and
 * is genuinely refused.
 */
describe('Registration validation', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const unique = () => `${Date.now()}.${Math.floor(Math.random() * 100_000)}`;

  /** Exactly what the web form sends — see the payload test at the bottom. */
  const validPayload = () => {
    const stamp = unique();
    return {
      organizationName: `Valid Org ${stamp}`,
      firstName: 'Valid',
      lastName: 'Owner',
      email: `valid.${stamp}@example.test`,
      password: 'Str0ng-Passphrase!2026',
      country: 'IN',
    };
  };

  const register = (payload: Record<string, unknown>) =>
    ctx.http().post('/api/v1/auth/register').send(payload);

  describe('field-level errors reach the client', () => {
    it('names the password field when it is too short', async () => {
      const response = await register({ ...validPayload(), password: 'short' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');

      /*
       * The assertion the defect would have failed. `details.password` is what
       * the form reads; `details._` is what it used to receive.
       */
      expect(response.body.error.details).toHaveProperty('password');
      expect(response.body.error.details.password[0]).toMatch(/at least 12 characters/i);
      expect(response.body.error.details).not.toHaveProperty('_');
    });

    it('names the email field when it is malformed', async () => {
      const response = await register({ ...validPayload(), email: 'not-an-email' });

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('email');
      expect(response.body.error.details.email[0]).toMatch(/valid email address/i);
    });

    it('names the country field when the code is not a real country', async () => {
      // 'ZZ' passes a length check and fails the ICU-backed one. The wrong
      // country here silently changes how every phone number is parsed, which
      // is why it is validated rather than trusted.
      const response = await register({ ...validPayload(), country: 'ZZ' });

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('country');
    });

    it('names the organization field when it is too short', async () => {
      const response = await register({ ...validPayload(), organizationName: 'A' });

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('organizationName');
      expect(response.body.error.details.organizationName[0]).toMatch(/at least 2 characters/i);
    });

    it('names EVERY invalid field at once, not just the first', async () => {
      const response = await register({
        organizationName: 'A',
        firstName: '',
        lastName: '',
        email: 'nope',
        password: 'short',
        country: 'ZZ',
      });

      expect(response.status).toBe(400);

      /*
       * Somebody who mistyped three fields should be told about three fields.
       * Reporting one at a time turns a single correction into three
       * round-trips, and the information is already there.
       */
      const details = response.body.error.details;
      for (const field of ['organizationName', 'firstName', 'lastName', 'email', 'password']) {
        expect(details).toHaveProperty(field);
      }
    });

    it('names the unexpected property when one is sent', async () => {
      // forbidNonWhitelisted stays ON. A client sending a field we do not
      // support should learn about it rather than have it silently dropped.
      const response = await register({ ...validPayload(), isPlatformOwner: true });

      expect(response.status).toBe(400);
      expect(response.body.error.details).toHaveProperty('isPlatformOwner');
    });

    it('strips the property name from the front of the message', async () => {
      // class-validator writes "password must be at least 12 characters"; the
      // form renders the label itself, so the repeat would read
      // "Password: password must be...".
      const response = await register({ ...validPayload(), password: 'short' });

      expect(response.body.error.details.password[0]).not.toMatch(/^password /);
    });
  });

  describe('the web form payload', () => {
    /**
     * The exact object `RegisterPage` sends.
     *
     * Kept here as a literal rather than imported, because the point is to fail
     * if the form and the DTO drift apart — reading the value from the form
     * would make this test agree with whatever the form does, including the
     * wrong thing. The web suite asserts the other half: that the form really
     * sends these keys.
     */
    const WEB_FORM_KEYS = [
      'organizationName',
      'firstName',
      'lastName',
      'email',
      'password',
      'country',
    ] as const;

    it('is accepted in full by RegisterDto', async () => {
      const payload = validPayload();

      // Guards against the form sending a key the DTO does not whitelist, which
      // with forbidNonWhitelisted is a 400 on a correctly filled form — the
      // worst version of this bug, because nothing the user does fixes it.
      expect(Object.keys(payload).sort()).toEqual([...WEB_FORM_KEYS].sort());

      const response = await register(payload);

      expect(response.status).toBe(201);
      expect(response.body.data.user.role).toBe('OWNER');
    });

    it('creates an ordinary CUSTOMER organization, never an internal one', async () => {
      const response = await register(validPayload()).expect(201);

      expect(response.body.data.user.role).toBe('OWNER');

      /*
       * The organization TYPE, read from the database.
       *
       * The column defaults to CUSTOMER, which is what makes the platform
       * marker safe to add: registration says nothing about it and could not
       * produce an internal organization even by accident. Asserted here
       * because "every new signup is a customer" is the guarantee that keeps
       * the platform console shut.
       */
      const organizationId = response.body.data.user.organization.id as string;

      const organization = await ctx.app
        .get(TenantContextService)
        .runAsSystem('e2e registration type check', () =>
          ctx.app
            .get(PrismaService)
            .client.organization.findFirst({
              where: { id: organizationId },
              select: { organizationType: true, status: true },
            }),
        );

      expect(organization).toMatchObject({ organizationType: 'CUSTOMER', status: 'ACTIVE' });
    });
  });
});
