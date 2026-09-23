import { createTestContext, PASSWORD, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * Workstream 4 — closed and archived leads must not remain operational work.
 *
 * A lead can become WON, LOST or ARCHIVED while open follow-ups still point at
 * it. Nothing errors; the follow-ups simply keep appearing in the overdue
 * bucket, inflating the one number the product exists to drive down. A team
 * that learns to ignore "overdue" because half of it is already-won business
 * has lost the only signal the CRM gives them.
 *
 * The policy implemented here: closing or archiving a lead CANCELS its open
 * follow-ups in the same transaction, preserving them as history rather than
 * deleting them, and records the reason on the timeline.
 */
describe('Closing a lead reconciles its follow-ups', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const mobile = (): string => fixtureMobile();

  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  const asSystem = async <T>(fn: (prisma: PrismaService['client']) => Promise<T>): Promise<T> => {
    const tenantContext = ctx.app.get(TenantContextService);
    const prisma = ctx.app.get(PrismaService);
    return tenantContext.runAsSystem('e2e closure fixture', () => fn(prisma.client));
  };

  let token = '';

  /** A lead with two open follow-ups, one of them already overdue. */
  const leadWithOpenFollowUps = async (): Promise<{ leadId: string; followUpIds: string[] }> => {
    const lead = await ctx
      .http()
      .post('/api/v1/leads')
      .set(auth(token))
      .send({
        firstName: 'Closing',
        lastName: 'Case',
        mobile: mobile(),
        estimatedValue: 5000,
        nextFollowUpAt: inDays(2),
      })
      .expect(201);

    const leadId = lead.body.data.id as string;
    const followUpIds: string[] = [];

    for (const days of [2, 4]) {
      const followUp = await ctx
        .http()
        .post(`/api/v1/leads/${leadId}/follow-ups`)
        .set(auth(token))
        .send({ scheduledAt: inDays(days), type: 'CALL' })
        .expect(201);

      followUpIds.push(followUp.body.data.id as string);
    }

    // Back-date one so it counts as overdue right now.
    await asSystem((prisma) =>
      prisma.followUp.update({
        where: { id: followUpIds[0] as string },
        data: { scheduledAt: new Date(Date.now() - 2 * 86_400_000), status: 'OVERDUE' },
      }),
    );

    return { leadId, followUpIds };
  };

  const openFollowUpsFor = async (leadId: string) =>
    asSystem((prisma) =>
      prisma.followUp.findMany({
        where: { leadId, status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } },
      }),
    );

  const allFollowUpsFor = async (leadId: string) =>
    asSystem((prisma) => prisma.followUp.findMany({ where: { leadId } }));

  beforeAll(async () => {
    ctx = await createTestContext();

    const registered = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({
        organizationName: `Closure ${unique('org')}`,
        email: `${unique('owner')}@example.test`,
        password: PASSWORD,
        firstName: 'Cleo',
        lastName: 'Close',
      })
      .expect(201);

    token = registered.body.data.tokens.accessToken as string;
    await asSystem((prisma) =>
      prisma.organization.update({
        where: { id: registered.body.data.user.organization.id as string },
        data: { timezone: 'UTC' },
      }),
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // The three ways a lead stops being live work
  // ---------------------------------------------------------------------------

  describe.each([
    ['WON', { status: 'WON', wonValue: 5000 }],
    ['LOST', { status: 'LOST', lostReason: 'Chose a competitor' }],
  ])('marking a lead %s', (_label, body) => {
    it('cancels every open follow-up', async () => {
      const { leadId } = await leadWithOpenFollowUps();
      expect(await openFollowUpsFor(leadId)).toHaveLength(2);

      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send(body)
        .expect(200);

      expect(await openFollowUpsFor(leadId)).toHaveLength(0);
    });

    it('preserves them as history rather than deleting them', async () => {
      const { leadId } = await leadWithOpenFollowUps();

      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send(body)
        .expect(200);

      // The record of what was planned is part of the relationship history.
      const all = await allFollowUpsFor(leadId);
      expect(all).toHaveLength(2);
      expect(all.every((followUp) => followUp.status === 'CANCELLED')).toBe(true);
      expect(all.every((followUp) => followUp.cancelledAt !== null)).toBe(true);
    });

    it('clears the lead’s next action', async () => {
      const { leadId } = await leadWithOpenFollowUps();

      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send(body)
        .expect(200);

      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .expect(200);

      expect(lead.body.data.nextFollowUpAt).toBeNull();
    });

    it('removes them from the overdue bucket', async () => {
      const { leadId } = await leadWithOpenFollowUps();

      const before = await ctx
        .http()
        .get('/api/v1/follow-ups?bucket=overdue')
        .set(auth(token))
        .expect(200);
      expect((before.body.data as { leadId: string }[]).some((f) => f.leadId === leadId)).toBe(
        true,
      );

      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send(body)
        .expect(200);

      const after = await ctx
        .http()
        .get('/api/v1/follow-ups?bucket=overdue')
        .set(auth(token))
        .expect(200);

      // The whole point. A won deal appearing as overdue teaches the team to
      // stop trusting the number.
      expect((after.body.data as { leadId: string }[]).some((f) => f.leadId === leadId)).toBe(
        false,
      );
    });

    it('records why on the lead timeline', async () => {
      const { leadId } = await leadWithOpenFollowUps();

      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send(body)
        .expect(200);

      const activities = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}/activities`)
        .set(auth(token))
        .expect(200);

      const items = activities.body.data.items as { type: string; description: string }[];
      expect(items.some((item) => /follow-up/i.test(item.description ?? ''))).toBe(true);
    });
  });

  describe('archiving a lead', () => {
    it('cancels every open follow-up', async () => {
      const { leadId } = await leadWithOpenFollowUps();

      await ctx.http().delete(`/api/v1/leads/${leadId}`).set(auth(token)).expect(204);

      expect(await openFollowUpsFor(leadId)).toHaveLength(0);
      expect(await allFollowUpsFor(leadId)).toHaveLength(2);
    });

    it('removes them from the overdue bucket', async () => {
      const { leadId } = await leadWithOpenFollowUps();

      await ctx.http().delete(`/api/v1/leads/${leadId}`).set(auth(token)).expect(204);

      const after = await ctx
        .http()
        .get('/api/v1/follow-ups?bucket=overdue')
        .set(auth(token))
        .expect(200);

      expect((after.body.data as { leadId: string }[]).some((f) => f.leadId === leadId)).toBe(
        false,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Downstream figures must agree
  // ---------------------------------------------------------------------------

  describe('reported figures', () => {
    it('drops the lead out of the dashboard overdue count', async () => {
      const { leadId } = await leadWithOpenFollowUps();

      const before = await ctx.http().get('/api/v1/dashboard').set(auth(token)).expect(200);

      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send({ status: 'WON', wonValue: 5000 })
        .expect(200);

      const after = await ctx.http().get('/api/v1/dashboard').set(auth(token)).expect(200);

      expect(after.body.data.followUps.overdue).toBe(
        before.body.data.followUps.overdue - 1,
      );
    });

    it('drops the lead out of the report overdue count', async () => {
      const { leadId } = await leadWithOpenFollowUps();

      const before = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(token))
        .expect(200);

      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send({ status: 'LOST', lostReason: 'Budget' })
        .expect(200);

      const after = await ctx
        .http()
        .get('/api/v1/reports/overview?preset=this_month')
        .set(auth(token))
        .expect(200);

      expect(after.body.data.followUps.overdue).toBe(
        before.body.data.followUps.overdue - 1,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Reopening
  // ---------------------------------------------------------------------------

  describe('reopening a lost lead', () => {
    it('requires a fresh next action rather than resurrecting cancelled work', async () => {
      const { leadId } = await leadWithOpenFollowUps();

      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send({ status: 'LOST', lostReason: 'Went quiet' })
        .expect(200);

      // Reopening must supply a new date. Silently reviving the cancelled
      // follow-ups would restore dates that are now in the past and put the
      // lead straight back into overdue.
      await ctx
        .http()
        .patch(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .send({ status: 'CONTACTED', nextFollowUpAt: inDays(3) })
        .expect(200);

      const open = await openFollowUpsFor(leadId);
      expect(open.length).toBeLessThanOrEqual(1);

      const lead = await ctx
        .http()
        .get(`/api/v1/leads/${leadId}`)
        .set(auth(token))
        .expect(200);
      expect(lead.body.data.nextFollowUpAt).not.toBeNull();
    });
  });
});
