import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * The request contract the web client must meet for complete and reschedule.
 *
 * The web hooks used to send `leadId` in these bodies. The API whitelists DTO
 * fields (`forbidNonWhitelisted`), so those requests were refused before the
 * follow-up was touched — every Complete and Reschedule from a dialog failed.
 * These pin both halves: the extra field is refused, and the body the client
 * now sends is accepted.
 */
describe('Follow-up request contract', () => {
  let ctx: TestContext;

  const owner = () => ({ Authorization: `Bearer ${ctx.orgA.owner.accessToken}` });
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  const leadWithFollowUp = async (): Promise<{ leadId: string; followUpId: string }> => {
    const response = await ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({
        firstName: 'Contract',
        mobile: fixtureMobile(),
        assignedToId: ctx.orgA.owner.id,
        nextFollowUpAt: inDays(2),
      })
      .expect(201);
    const leadId = response.body.data.id as string;

    const open = await asSystem('e2e read follow-ups', () =>
      prisma().followUp.findFirst({
        where: { leadId, status: { in: ['UPCOMING', 'DUE', 'OVERDUE'] } },
        select: { id: true },
      }),
    );
    if (open) return { leadId, followUpId: open.id };

    // Older lead creation wrote only the date; schedule a real row.
    const created = await ctx
      .http()
      .post(`/api/v1/leads/${leadId}/follow-ups`)
      .set(owner())
      .send({ scheduledAt: inDays(2) })
      .expect(201);
    return { leadId, followUpId: created.body.data.id as string };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses a completion that carries leadId — what the old client sent', async () => {
    const { leadId, followUpId } = await leadWithFollowUp();

    const response = await ctx
      .http()
      .post(`/api/v1/follow-ups/${followUpId}/complete`)
      .set(owner())
      .send({ leadId, outcome: 'Interested', nextFollowUpAt: inDays(4) });

    expect([400, 422]).toContain(response.status);
  });

  it('refuses a reschedule that carries leadId — what the old client sent', async () => {
    const { leadId, followUpId } = await leadWithFollowUp();

    const response = await ctx
      .http()
      .post(`/api/v1/follow-ups/${followUpId}/reschedule`)
      .set(owner())
      .send({ leadId, scheduledAt: inDays(3) });

    expect([400, 422]).toContain(response.status);
  });

  it('accepts the completion body the fixed client sends', async () => {
    const { followUpId } = await leadWithFollowUp();

    await ctx
      .http()
      .post(`/api/v1/follow-ups/${followUpId}/complete`)
      .set(owner())
      .send({ outcome: 'Interested', nextFollowUpAt: inDays(4) })
      .expect(200);
  });

  it('accepts the reschedule body the fixed client sends', async () => {
    const { followUpId } = await leadWithFollowUp();

    await ctx
      .http()
      .post(`/api/v1/follow-ups/${followUpId}/reschedule`)
      .set(owner())
      .send({ scheduledAt: inDays(3) })
      .expect(200);
  });
});
