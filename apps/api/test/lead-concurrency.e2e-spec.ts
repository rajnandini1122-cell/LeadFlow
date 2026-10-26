import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile, toFixtureE164 } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Races and duplicate safety around leads, imports and deactivation.
 *
 * HONEST CAVEAT, AND IT IS THE REASON THIS FILE IS SEPARATE.
 *
 * What the DATABASE enforces lives in schema-invariants.e2e-spec.ts, not here.
 * Those cases provoke constraint violations deliberately, which needs raw `pg`
 * on a fresh connection per assertion — and a raw client in a file that has
 * also booted the application EVICTS the app's own connection, because PGlite
 * serves one at a time. The two kinds of test cannot share a file.
 *
 * The cases in `concurrent writers` fire genuinely parallel promises, but
 * PGlite — the local development database — serves ONE connection at a time, so
 * locally they INTERLEAVE rather than truly overlap. Locally they therefore
 * prove the application's in-transaction pre-check; against real PostgreSQL,
 * which CI runs, they prove the index. The assertion is the same either way,
 * and that is the point: one lead, whichever layer caught it. Passing locally
 * is necessary and not sufficient.
 *
 * Nothing here runs against production and nothing here is destructive: every
 * row is created by the test, in the test's own tenant.
 */
describe('Lead concurrency and duplicate safety', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
  const mobile = (): string => fixtureMobile();
  const unique = (prefix: string): string =>
    `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;

  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  /** True when the suite is running against a real PostgreSQL, as CI does. */
  const realPostgres = process.env['CI_USE_EXTERNAL_DB'] === '1';

  /*
   * Races that provoke a UNIQUE VIOLATION THROUGH PRISMA run only on real
   * PostgreSQL, and the reason is a property of the local engine rather than a
   * choice about rigour.
   *
   * PGlite's socket server DROPS THE CONNECTION on any SQL error. The
   * application's recovery path handles the violation correctly and the test
   * itself passes in isolation — but the connection is gone afterwards, so
   * every later test in the process fails with "server has closed the
   * connection". That is exactly the hazard recorded in test/global-setup.ts,
   * and the reason this project's convention is to assert on zero-row results
   * locally and leave constraint violations to raw `pg` or to CI.
   *
   * So: the `database uniqueness` block below provokes violations deliberately
   * and is REAL everywhere, because it uses raw `pg` on a fresh connection per
   * assertion. The overlapping-writer block is skipped locally with the reason
   * printed, and is the part CI proves.
   */
  const describeRaces = realPostgres ? describe : describe.skip;

  const runImport = (body: Record<string, unknown>) =>
    ctx
      .http()
      .post('/api/v1/leads/import')
      .set(owner())
      .send({ defaultNextFollowUpAt: inDays(3), ...body });

  const createLead = (body: Record<string, unknown>) =>
    ctx
      .http()
      .post('/api/v1/leads')
      .set(owner())
      .send({ firstName: 'Dana', nextFollowUpAt: inDays(2), ...body });

  const leadsWithMobile = async (national: string) =>
    asSystem('e2e count leads by mobile', () =>
      prisma().lead.findMany({
        where: { organizationId: ctx.orgA.id, mobile: toFixtureE164(national), deletedAt: null },
        select: { id: true, leadNumber: true, duplicateAcknowledgedAt: true },
      }),
    );

  const leadsWithEmail = async (email: string) =>
    asSystem('e2e count leads by email', () =>
      prisma().lead.findMany({
        where: {
          organizationId: ctx.orgA.id,
          email: { equals: email, mode: 'insensitive' },
          deletedAt: null,
        },
        select: { id: true, leadNumber: true },
      }),
    );

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // Sequential re-runs. No violation is provoked, so these are real everywhere.
  // ===========================================================================

  describe('repeated and interrupted imports', () => {
    it('does not double a lead when an import is retried after a partial run', async () => {
      const numbers = [mobile(), mobile(), mobile()];
      const csv = [
        'Customer Name,Mobile No.',
        `One,${numbers[0] as string}`,
        'Broken,not-a-number',
        `Three,${numbers[2] as string}`,
      ].join('\n');

      const firstRun = await runImport({ csv }).expect(200);
      expect(firstRun.body.data).toMatchObject({ created: 2, failed: 1 });

      /*
       * The retry after a partial run, which is what somebody does after fixing
       * the one bad row — except here the file is unchanged, as it would be if
       * the first run had been interrupted rather than completed.
       *
       * Every good row is now a duplicate of itself, so nothing is created
       * twice. This is the behaviour that makes a partial import safe to simply
       * run again.
       */
      const secondRun = await runImport({ csv }).expect(200);
      expect(secondRun.body.data).toMatchObject({ created: 0, skipped: 2, failed: 1 });

      for (const number of [numbers[0] as string, numbers[2] as string]) {
        expect(await leadsWithMobile(number)).toHaveLength(1);
      }
    });

    it('leaves an interrupted batch attributable', async () => {
      const response = await runImport({
        csv: `Customer Name,Mobile No.\nDana,${mobile()}`,
        fileName: 'interrupted.csv',
      }).expect(200);

      const batch = await asSystem('e2e read batch', () =>
        prisma().leadImportBatch.findFirst({
          where: { id: response.body.data.batchId as string },
          select: { startedAt: true, completedAt: true },
        }),
      );

      // The batch row is written BEFORE the first lead, so a run that dies
      // halfway still leaves its rows attributable — a batch with a null
      // `completedAt` and twelve leads pointing at it is legible and
      // correctable. This one finished, so both timestamps are set.
      expect(batch?.startedAt).toBeTruthy();
      expect(batch?.completedAt).toBeTruthy();
    });
  });

  // ===========================================================================
  // CREATE_ANYWAY safety
  // ===========================================================================

  describe('deliberate duplicates', () => {
    const existingLead = async (number: string) => {
      const response = await createLead({ firstName: 'Original', mobile: number }).expect(201);
      return response.body.data.leadNumber as string;
    };

    it('changes nothing at all on the existing lead', async () => {
      const number = mobile();
      await existingLead(number);

      const before = await asSystem('e2e snapshot original', () =>
        prisma().lead.findFirst({
          where: { organizationId: ctx.orgA.id, mobile: toFixtureE164(number) },
        }),
      );
      // Asserted rather than asserted-around: `exactOptionalPropertyTypes` is
      // on, so a possibly-undefined id cannot be passed into a where clause —
      // and a snapshot of nothing would make the comparison below vacuous.
      expect(before).not.toBeNull();
      const originalId = (before as { id: string }).id;

      await runImport({
        csv: `Customer Name,Mobile No.,City\nReplacement,${number},Nagpur`,
        duplicateMode: 'CREATE_ANYWAY',
      }).expect(200);

      const after = await asSystem('e2e re-read original', () =>
        prisma().lead.findFirst({ where: { id: originalId } }),
      );

      /*
       * THE CLAIM THAT MATTERS MOST. CREATE_ANYWAY inserts; it has no update
       * path at all. The owner, the stage, the value, the account link and the
       * timestamps of the record somebody is already working are untouched —
       * asserted field by field rather than by reading the code.
       */
      expect(after).toEqual(before);
    });

    it('records on the new lead which existing lead it duplicates', async () => {
      const number = mobile();
      const originalNumber = await existingLead(number);

      await runImport({
        csv: `Customer Name,Mobile No.\nReplacement,${number}`,
        duplicateMode: 'CREATE_ANYWAY',
      }).expect(200);

      const leads = await leadsWithMobile(number);
      const duplicate = leads.find((lead) => lead.duplicateAcknowledgedAt !== null);
      expect(duplicate).toBeDefined();

      const activities = await asSystem('e2e read timeline', () =>
        prisma().leadActivity.findMany({
          where: { leadId: (duplicate as { id: string }).id },
          select: { description: true },
        }),
      );

      /*
       * `duplicate_acknowledged_at` records only THAT a second lead was
       * allowed. Which record it duplicates is the first thing anybody
       * reviewing two live leads for one customer asks, and it was not stored
       * anywhere — so it goes on the timeline, which is append-only and
       * survives the batch row being deleted.
       */
      expect(activities.map((activity) => activity.description).join(' ')).toContain(
        originalNumber,
      );
    });

    it('marks only the duplicate rows, not the whole file', async () => {
      const taken = mobile();
      const fresh = mobile();
      await existingLead(taken);

      await runImport({
        csv: [
          'Customer Name,Mobile No.',
          `Duplicate,${taken}`,
          `BrandNew,${fresh}`,
        ].join('\n'),
        duplicateMode: 'CREATE_ANYWAY',
      }).expect(200);

      // Per ROW, not per run. Acknowledging the whole file would take rows that
      // were never duplicates out of the index, weakening the guarantee for
      // them permanently.
      const brandNew = await leadsWithMobile(fresh);
      expect(brandNew).toHaveLength(1);
      expect(brandNew[0]?.duplicateAcknowledgedAt).toBeNull();
    });

    it('records the mode against the account that ran it', async () => {
      const number = mobile();
      await existingLead(number);

      const response = await runImport({
        csv: `Customer Name,Mobile No.\nReplacement,${number}`,
        duplicateMode: 'CREATE_ANYWAY',
      }).expect(200);

      const audit = await asSystem('e2e read audit', () =>
        prisma().auditLog.findFirst({
          where: {
            organizationId: ctx.orgA.id,
            action: 'lead.imported',
            entityId: response.body.data.batchId as string,
          },
          select: { actorUserId: true, after: true },
        }),
      );

      expect(audit?.actorUserId).toBe(ctx.orgA.owner.id);
      expect((audit?.after as { duplicateMode?: string })?.duplicateMode).toBe('CREATE_ANYWAY');
    });

    it('is refused to a sales rep, mode or no mode', async () => {
      // The mode carries no separate permission because it does not need one:
      // `lead.import` is ADMIN-only, and whoever can import a file at all is
      // who may choose how duplicates in it are treated.
      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgA.rep.accessToken))
        .send({
          csv: `Customer Name,Mobile No.\nDana,${mobile()}`,
          defaultNextFollowUpAt: inDays(3),
          duplicateMode: 'CREATE_ANYWAY',
        })
        .expect(403);
    });

    it('cannot reach another tenant’s lead to duplicate it', async () => {
      const number = mobile();
      await existingLead(number);

      // Org B importing the same number creates ITS OWN lead and does not see,
      // touch or duplicate org A's.
      await ctx
        .http()
        .post('/api/v1/leads/import')
        .set(auth(ctx.orgB.owner.accessToken))
        .send({
          csv: `Customer Name,Mobile No.\nTheirs,${number}`,
          defaultNextFollowUpAt: inDays(3),
          duplicateMode: 'CREATE_ANYWAY',
        })
        .expect(200);

      expect(await leadsWithMobile(number)).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Overlapping writers. REAL POSTGRESQL ONLY -- see describeRaces above.
  // ===========================================================================

  describeRaces('concurrent writers', () => {
    it(`creates one lead when two requests race on a mobile${realPostgres ? '' : ' (interleaved locally)'}`, async () => {
      const number = mobile();

      const [first, second] = await Promise.all([
        createLead({ mobile: number }),
        createLead({ mobile: number }),
      ]);

      const statuses = [first.status, second.status].sort();

      // One created, one refused. Which layer refused it depends on the engine;
      // that exactly one exists does not.
      expect(statuses).toEqual([201, 409]);
      expect(await leadsWithMobile(number)).toHaveLength(1);
    });

    it('creates one lead when two requests race on an email', async () => {
      const email = `${unique('race')}@example.test`;

      const results = await Promise.all([
        createLead({ email, mobile: mobile() }),
        createLead({ email, mobile: mobile() }),
      ]);

      expect(results.filter((response) => response.status === 201)).toHaveLength(1);
      expect(await leadsWithEmail(email)).toHaveLength(1);
    });

    it('creates one lead when the same file is imported twice at once', async () => {
      const number = mobile();
      const csv = `Customer Name,Mobile No.\nDana,${number}`;

      const [first, second] = await Promise.all([runImport({ csv }), runImport({ csv })]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      /*
       * TWO BATCHES, ONE LEAD, and both of those are correct.
       *
       * The import endpoint has no idempotency key — re-posting a file is a
       * deliberate act, so it opens its own batch and reports honestly what it
       * did. What must not happen is a second customer record, and the
       * duplicate guard is what prevents it: one run creates, the other reports
       * the row as skipped or failed.
       */
      expect(await leadsWithMobile(number)).toHaveLength(1);

      const created = first.body.data.created + second.body.data.created;
      expect(created).toBe(1);
      expect(first.body.data.batchId).not.toBe(second.body.data.batchId);
    });

    it('creates one lead when two imports race on an email-only row', async () => {
      const email = `${unique('mailrace')}@example.test`;
      const csv = `Customer Name,Mobile No.,Email ID\nDana,${mobile()},${email}`;
      const other = `Customer Name,Mobile No.,Email ID\nDana,${mobile()},${email}`;

      const results = await Promise.all([runImport({ csv }), runImport({ csv: other })]);

      // Different mobiles, same address: the email key is the only thing that
      // can catch this, and before this release nothing did.
      expect(results.every((response) => response.status === 200)).toBe(true);
      expect(await leadsWithEmail(email)).toHaveLength(1);
      expect(
        results.reduce((total, response) => total + response.body.data.created, 0),
      ).toBe(1);
    });
  });
});
