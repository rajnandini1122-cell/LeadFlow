import { ERROR_CODES } from '@leadflow/api-types';
import { createTestContext, type TestContext } from './helpers/test-app';

/**
 * Deliberate duplicate leads.
 *
 * The product allows two live leads for the same person on purpose — a repeat
 * customer with a second, unrelated enquiry is a real thing, and forcing that
 * into one lead destroys the ability to report on either. `allowDuplicate` is
 * the caller saying "yes, I meant it".
 *
 * This suite exists because that opt-in returned HTTP 500 from Phase B until
 * Phase H. The cases below pin down both halves: the safety rail still holds by
 * default, and opting in actually works.
 */
describe('Creating a deliberate duplicate lead', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let counter = 0;
  const uniqueMobile = () => {
    counter += 1;
    return `+1415555${String(7000 + counter).slice(-4)}`;
  };

  async function createLead(body: Record<string, unknown>, token?: string) {
    return ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token ?? ctx.orgA.owner.accessToken))
      .send({
        firstName: 'Rahul',
        nextFollowUpAt: new Date(Date.now() + 86_400_000).toISOString(),
        ...body,
      });
  }

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('the safety rail, unchanged', () => {
    it('refuses a second lead for the same mobile by default', async () => {
      const mobile = uniqueMobile();
      expect((await createLead({ mobile })).status).toBe(201);

      const second = await createLead({ mobile });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe(ERROR_CODES.DUPLICATE_LEAD);
    });

    it('tells the client which lead already exists, so it can offer to open it', async () => {
      const mobile = uniqueMobile();
      const first = await createLead({ mobile });

      const second = await createLead({ mobile });

      expect(second.body.error.details.existingLeadId[0]).toBe(first.body.data.id);
      expect(second.body.error.details.existingLeadNumber[0]).toBe(first.body.data.leadNumber);
    });
  });

  describe('opting in', () => {
    it('creates the second lead instead of failing', async () => {
      const mobile = uniqueMobile();
      const first = await createLead({ mobile });
      expect(first.status).toBe(201);

      const second = await createLead({ mobile, allowDuplicate: true });

      // The defect: this used to be a 500 because the database index refused
      // what the API had just agreed to.
      expect(second.status).toBe(201);
      expect(second.body.data.id).not.toBe(first.body.data.id);
      expect(second.body.data.leadNumber).not.toBe(first.body.data.leadNumber);
    });

    it('leaves both leads live and independently workable', async () => {
      const mobile = uniqueMobile();
      const first = await createLead({ mobile, assignedToId: ctx.orgA.rep.id });
      const second = await createLead({
        mobile,
        allowDuplicate: true,
        assignedToId: ctx.orgA.owner.id,
      });

      const a = await ctx
        .http()
        .get(`/api/v1/leads/${first.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken));
      const b = await ctx
        .http()
        .get(`/api/v1/leads/${second.body.data.id}`)
        .set(auth(ctx.orgA.owner.accessToken));

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // Two enquiries from one person, each with its own owner. Collapsing
      // them would destroy the ability to report on either.
      expect(a.body.data.assignedTo?.id ?? a.body.data.assignedToId).toBe(ctx.orgA.rep.id);
      expect(b.body.data.assignedTo?.id ?? b.body.data.assignedToId).toBe(ctx.orgA.owner.id);
    });

    it('still refuses a THIRD lead that does not opt in', async () => {
      const mobile = uniqueMobile();
      await createLead({ mobile });
      await createLead({ mobile, allowDuplicate: true });

      const third = await createLead({ mobile });

      // Opting in once must not disarm the rail for everyone afterwards.
      expect(third.status).toBe(409);
      expect(third.body.error.code).toBe(ERROR_CODES.DUPLICATE_LEAD);
    });

    it('allows a further deliberate duplicate', async () => {
      const mobile = uniqueMobile();
      await createLead({ mobile });
      expect((await createLead({ mobile, allowDuplicate: true })).status).toBe(201);
      expect((await createLead({ mobile, allowDuplicate: true })).status).toBe(201);
    });

    it('records that the duplicate was deliberate', async () => {
      const mobile = uniqueMobile();
      await createLead({ mobile });
      const second = await createLead({ mobile, allowDuplicate: true });

      const audit = await ctx
        .http()
        .get('/api/v1/organizations/audit')
        .set(auth(ctx.orgA.owner.accessToken));

      const entry = audit.body.data.items.find(
        (row: { entityId: string }) => row.entityId === second.body.data.id,
      );

      // Two live leads for one person is a decision somebody made. The trail
      // is what makes it answerable later.
      expect(entry?.after?.duplicateOverridden).toBe(true);
    });
  });

  describe('the rail is per organization', () => {
    it('does not treat another tenant’s lead as a duplicate', async () => {
      const mobile = uniqueMobile();
      expect((await createLead({ mobile })).status).toBe(201);

      // The same human can be a customer of two businesses. Neither should
      // learn about the other.
      const inB = await createLead({ mobile }, ctx.orgB.owner.accessToken);
      expect(inB.status).toBe(201);
    });
  });

  describe('concurrent creates', () => {
    it('still lets only one through when neither opted in', async () => {
      const mobile = uniqueMobile();

      const [first, second] = await Promise.all([
        createLead({ mobile }),
        createLead({ mobile }),
      ]);

      const statuses = [first.status, second.status].sort();
      // The index is the backstop for exactly this: two requests that each
      // checked and each found nothing.
      expect(statuses).toEqual([201, 409]);
    });
  });
});
