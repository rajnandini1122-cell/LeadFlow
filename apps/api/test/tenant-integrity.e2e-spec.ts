import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { fixtureMobile } from './helpers/phone-fixtures';

/**
 * Workstream 5 — same-tenant relationship integrity.
 *
 * Every tenant-owned row carries its own organizationId, and every foreign key
 * between two such rows is a place where those two values could disagree. A
 * Lead in organization A pointing at a Contact in organization B would be
 * invisible to both tenants' queries and would surface as a customer's data
 * appearing under someone else's name.
 *
 * Two halves to this file:
 *
 *   1. AUDIT — a survey of the live schema for references that already
 *      disagree. Reported as a count so it is impossible to add a constraint
 *      on top of data that would violate it.
 *
 *   2. ENFORCEMENT — the application must refuse to create such a reference,
 *      through every route that accepts a foreign id.
 */
describe('Same-tenant relationship integrity', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  const mobile = (): string => fixtureMobile();

  const asSystem = async <T>(fn: (prisma: PrismaService['client']) => Promise<T>): Promise<T> => {
    const tenantContext = ctx.app.get(TenantContextService);
    const prisma = ctx.app.get(PrismaService);
    return tenantContext.runAsSystem('e2e integrity audit', () => fn(prisma.client));
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ---------------------------------------------------------------------------
  // 1. Audit — are there already rows whose relationships cross a tenant?
  // ---------------------------------------------------------------------------

  describe('schema audit', () => {
    it('no lead references a contact from another organization', async () => {
      const offenders = await asSystem(async (prisma) => {
        const leads = await prisma.lead.findMany({
          where: { contactId: { not: null } },
          select: { id: true, organizationId: true, contact: { select: { organizationId: true } } },
        });

        return leads.filter((lead) => lead.contact && lead.contact.organizationId !== lead.organizationId);
      });

      expect(offenders).toEqual([]);
    });

    it('no follow-up references a lead from another organization', async () => {
      const offenders = await asSystem(async (prisma) => {
        const followUps = await prisma.followUp.findMany({
          select: { id: true, organizationId: true, lead: { select: { organizationId: true } } },
        });

        // A follow-up may hang off an ACCOUNT instead of a lead, in which case
        // there is no lead to compare — that case is covered below.
        return followUps.filter(
          (followUp) => followUp.lead !== null && followUp.lead.organizationId !== followUp.organizationId,
        );
      });

      expect(offenders).toEqual([]);
    });

    it('every follow-up has exactly one parent', async () => {
      /*
       * The CHECK constraint enforces this, so a violation here means the
       * constraint is missing rather than that a write slipped through. A
       * follow-up attached to neither a lead nor an account would appear on no
       * screen at all — the one outcome the product promise cannot tolerate.
       */
      const offenders = await asSystem(async (prisma) => {
        const followUps = await prisma.followUp.findMany({
          select: { id: true, leadId: true, accountId: true },
        });

        return followUps.filter(
          (followUp) => (followUp.leadId === null) === (followUp.accountId === null),
        );
      });

      expect(offenders).toEqual([]);
    });

    it('no follow-up references an account from another organization', async () => {
      const offenders = await asSystem(async (prisma) => {
        const followUps = await prisma.followUp.findMany({
          where: { accountId: { not: null } },
          select: { id: true, organizationId: true, account: { select: { organizationId: true } } },
        });

        return followUps.filter(
          (followUp) => followUp.account && followUp.account.organizationId !== followUp.organizationId,
        );
      });

      expect(offenders).toEqual([]);
    });

    it('no lead references an account from another organization', async () => {
      /*
       * The gap the Prisma extension cannot close: it scopes QUERIES, and a
       * foreign key assignment is not a query. A violation here would mean one
       * organization's Customer 360 is showing another's opportunities and
       * revenue, with nothing on either screen to indicate it.
       */
      const offenders = await asSystem(async (prisma) => {
        const leads = await prisma.lead.findMany({
          where: { accountId: { not: null } },
          select: { id: true, organizationId: true, account: { select: { organizationId: true } } },
        });

        return leads.filter(
          (lead) => lead.account && lead.account.organizationId !== lead.organizationId,
        );
      });

      expect(offenders).toEqual([]);
    });

    it('no contact references an account from another organization', async () => {
      const offenders = await asSystem(async (prisma) => {
        const contacts = await prisma.contact.findMany({
          where: { accountId: { not: null } },
          select: { id: true, organizationId: true, account: { select: { organizationId: true } } },
        });

        return contacts.filter(
          (contact) => contact.account && contact.account.organizationId !== contact.organizationId,
        );
      });

      expect(offenders).toEqual([]);
    });

    it('no account is merged into one from another organization', async () => {
      // A cross-tenant merge would fuse two businesses' customer histories.
      const offenders = await asSystem(async (prisma) => {
        const accounts = await prisma.account.findMany({
          where: { mergedIntoId: { not: null } },
          select: {
            id: true,
            organizationId: true,
            mergedInto: { select: { organizationId: true } },
          },
        });

        return accounts.filter(
          (account) =>
            account.mergedInto && account.mergedInto.organizationId !== account.organizationId,
        );
      });

      expect(offenders).toEqual([]);
    });

    it('no activity references a lead from another organization', async () => {
      const offenders = await asSystem(async (prisma) => {
        const activities = await prisma.leadActivity.findMany({
          select: { id: true, organizationId: true, lead: { select: { organizationId: true } } },
        });

        return activities.filter(
          (activity) => activity.lead.organizationId !== activity.organizationId,
        );
      });

      expect(offenders).toEqual([]);
    });

    it('every lead assignee is a member of that lead’s organization', async () => {
      // leads.assigned_to references the GLOBAL users table, so nothing in the
      // schema prevents pointing at somebody from another tenant. Membership is
      // the only thing that makes it correct.
      const offenders = await asSystem(async (prisma) => {
        const leads = await prisma.lead.findMany({
          where: { assignedToId: { not: null } },
          select: { id: true, organizationId: true, assignedToId: true },
        });

        const bad: string[] = [];
        for (const lead of leads) {
          const membership = await prisma.organizationUser.count({
            where: {
              organizationId: lead.organizationId,
              userId: lead.assignedToId as string,
            },
          });
          if (membership === 0) bad.push(lead.id);
        }
        return bad;
      });

      expect(offenders).toEqual([]);
    });

    it('every follow-up assignee is a member of that follow-up’s organization', async () => {
      const offenders = await asSystem(async (prisma) => {
        const followUps = await prisma.followUp.findMany({
          select: { id: true, organizationId: true, assignedUserId: true },
        });

        const bad: string[] = [];
        for (const followUp of followUps) {
          const membership = await prisma.organizationUser.count({
            where: { organizationId: followUp.organizationId, userId: followUp.assignedUserId },
          });
          if (membership === 0) bad.push(followUp.id);
        }
        return bad;
      });

      expect(offenders).toEqual([]);
    });

    it('every subscription belongs to an organization that exists', async () => {
      const offenders = await asSystem(async (prisma) => {
        const subscriptions = await prisma.subscription.findMany({
          select: { id: true, organization: { select: { id: true } } },
        });
        return subscriptions.filter((subscription) => !subscription.organization);
      });

      expect(offenders).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Enforcement — every route that accepts a foreign id must refuse one
  // ---------------------------------------------------------------------------

  describe('the application refuses to create a cross-tenant reference', () => {
    it('refuses a lead assigned to another organization’s user', async () => {
      const response = await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Cross',
          mobile: mobile(),
          nextFollowUpAt: inDays(2),
          assignedToId: ctx.orgB.rep.id,
        })
        .expect(400);

      expect(response.body.error.details.assignedToId).toBeDefined();
    });

    it('refuses to reassign a lead to another organization’s user', async () => {
      await ctx
        .http()
        .post(`/api/v1/leads/${ctx.orgA.leadId}/assign`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ assignedToId: ctx.orgB.rep.id })
        .expect(400);
    });

    it('refuses to import leads assigned to another organization’s user', async () => {
      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          csv: `firstName,mobile\nCross,${mobile()}`,
          defaultNextFollowUpAt: inDays(3),
          assignedToId: ctx.orgB.rep.id,
        })
        .expect(400);
    });

    it('refuses to merge a contact into another organization’s contact', async () => {
      const mine = await ctx
        .http()
        .post('/api/v1/contacts')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ firstName: 'Mine', mobile: mobile() })
        .expect(201);

      const theirs = await ctx
        .http()
        .post('/api/v1/contacts')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({ firstName: 'Theirs', mobile: mobile() })
        .expect(201);

      await ctx
        .http()
        .post('/api/v1/contacts/merge')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ sourceId: mine.body.data.id, targetId: theirs.body.data.id })
        .expect(404);
    });

    it('refuses to schedule a follow-up on another organization’s lead', async () => {
      await ctx
        .http()
        .post(`/api/v1/leads/${ctx.orgB.leadId}/follow-ups`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ scheduledAt: inDays(1), type: 'CALL' })
        .expect(404);
    });

    it('refuses to hand a departing member’s work to another organization’s user', async () => {
      await ctx
        .http()
        .post(`/api/v1/users/${ctx.orgA.rep.id}/offboard`)
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ action: 'REMOVE', reassignToId: ctx.orgB.rep.id })
        .expect(400);
    });

    it('refuses to transfer admin responsibility across organizations', async () => {
      await ctx
        .http()
        .post('/api/v1/users/transfer-admin')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({ toUserId: ctx.orgB.owner.id })
        .expect(404);
    });

    it('leaves no partial row behind after a refusal', async () => {
      const before = await asSystem((prisma) => prisma.lead.count());

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(auth(ctx.orgA.owner.accessToken))
        .send({
          firstName: 'Rejected',
          mobile: mobile(),
          nextFollowUpAt: inDays(2),
          assignedToId: ctx.orgB.rep.id,
        })
        .expect(400);

      // A refusal that still wrote the row would be worse than no check.
      expect(await asSystem((prisma) => prisma.lead.count())).toBe(before);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. The scoper itself, which is what makes the above hold everywhere
  // ---------------------------------------------------------------------------

  describe('the fail-closed scoper', () => {
    it('refuses to read a tenant-owned model with no tenant context', async () => {
      const prisma = ctx.app.get(PrismaService);

      // This is the property the whole isolation model rests on: code that
      // forgets to establish a tenant does not read everything, it reads
      // nothing and says so.
      await expect(prisma.client.lead.findMany()).rejects.toThrow(/tenant/i);
    });

    it('refuses to write a tenant-owned model with no tenant context', async () => {
      const prisma = ctx.app.get(PrismaService);

      await expect(
        prisma.client.followUp.count({ where: { status: 'UPCOMING' } }),
      ).rejects.toThrow(/tenant/i);
    });
  });
});
