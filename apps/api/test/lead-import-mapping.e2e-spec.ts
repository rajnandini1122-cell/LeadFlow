import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile, toFixtureE164 } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * CSV import, over HTTP, against the defects that were actually reported.
 *
 * Five claims, and every case here is one of them:
 *
 *   THE ADDRESS ARRIVES. `leads` held only `city`, so an address column was
 *   dropped or concatenated into a field that meant something else. Six columns
 *   now exist and are mapped, and the imported lead carries them.
 *
 *   PREVIEW AND IMPORT AGREE. They shared a validator but called it with
 *   different arguments, so a row the preview counted valid could be rejected
 *   by the import. The same file now produces the same verdict from both.
 *
 *   ERRORS ARE ACTIONABLE. A row-level reason naming the value, and the whole
 *   set as downloadable CSV — not the first twenty on screen.
 *
 *   NOTHING IS SILENTLY DISCARDED. An unmapped column, a guessed column, a
 *   duplicated header and a collision are each reported.
 *
 *   PREVIEW WRITES NOTHING. Asserted by counting leads around it.
 */
describe('CSV import mapping and batches', () => {
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

  const preview = (body: Record<string, unknown>) =>
    ctx.http().post('/api/v1/leads/import/preview').set(owner()).send(body);

  const runImport = (body: Record<string, unknown>) =>
    ctx
      .http()
      .post('/api/v1/leads/import')
      .set(owner())
      .send({ defaultNextFollowUpAt: inDays(3), ...body });

  /**
   * Looked up by the CANONICAL number, not the one in the CSV.
   *
   * The fixture gives a national number as a person would type it; the lead
   * stores E.164, because canonicalising before the duplicate check is what
   * makes "+1 415 555 0100" and "4155550100" the same customer.
   */
  const leadByMobile = async (national: string) =>
    asSystem('e2e read imported lead', () =>
      prisma().lead.findFirst({
        where: { organizationId: ctx.orgA.id, mobile: toFixtureE164(national) },
      }),
    );

  const activeLeadCount = async (): Promise<number> =>
    asSystem('e2e count leads', () =>
      prisma().lead.count({ where: { organizationId: ctx.orgA.id, deletedAt: null } }),
    );

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  // ===========================================================================
  // The address — the defect that prompted this work
  // ===========================================================================

  describe('address mapping', () => {
    it('suggests a field for every column of a real Indian export', async () => {
      const response = await preview({
        csv: [
          'Customer Name,Mobile No.,Email ID,Address Line 1,Address Line 2,City,State,PIN Code,Country',
          `Dana Whitfield,${mobile()},${unique('dana')}@example.test,12 High Street,Near the market,Pune,Maharashtra,411001,IN`,
        ].join('\n'),
      }).expect(200);

      // Nine columns in, nine mapped. Before this release the five address
      // columns matched nothing and vanished without comment.
      expect(Object.keys(response.body.data.mapping)).toHaveLength(9);
      expect(response.body.data.unmapped).toEqual([]);
      expect(response.body.data.mapping['PIN Code']).toBe('postalCode');
      expect(response.body.data.mapping['Address Line 2']).toBe('addressLine2');
    });

    it('stores the whole address on the lead', async () => {
      const number = mobile();

      await runImport({
        csv: [
          'Customer Name,Mobile No.,Address Line 1,Address Line 2,City,State,PIN Code,Country',
          `Dana Whitfield,${number},12 High Street,Near the market,Pune,Maharashtra,411001,in`,
        ].join('\n'),
      }).expect(200);

      const lead = await leadByMobile(number);

      expect(lead).toMatchObject({
        addressLine1: '12 High Street',
        addressLine2: 'Near the market',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
        // Upper-cased, so a file writing "in" and one writing "IN" are one
        // country rather than two in every filter afterwards.
        country: 'IN',
      });
    });

    it('never puts a whole address into an unrelated field', async () => {
      const number = mobile();

      await runImport({
        csv: `Customer Name,Mobile No.,Address Line 1\nDana,${number},"12 High Street, Pune, 411001"`,
      }).expect(200);

      const lead = await leadByMobile(number);

      expect(lead?.addressLine1).toBe('12 High Street, Pune, 411001');
      // The quoted comma must not have shifted anything, and the address must
      // not have landed in the company or the product-interest field.
      expect(lead?.companyName).toBeNull();
      expect(lead?.productInterest).toBeNull();
      expect(lead?.city).toBeNull();
    });

    it('keeps a PIN code with a leading zero', async () => {
      const number = mobile();

      await runImport({
        csv: `Customer Name,Mobile No.,PIN Code\nDana,${number},012345`,
      }).expect(200);

      // A numeric column would have stored 12345. Several countries have codes
      // where the leading zero is part of the code.
      expect((await leadByMobile(number))?.postalCode).toBe('012345');
    });

    it('refuses a country that is not a two-letter code', async () => {
      const response = await preview({
        csv: `Customer Name,Mobile No.,Country\nDana,${mobile()},India`,
        defaultNextFollowUpAt: inDays(3),
      }).expect(200);

      expect(response.body.data.invalidRows).toBe(1);
      expect(response.body.data.rows[0].errors.join(' ')).toMatch(/two-letter country code/);
    });
  });

  // ===========================================================================
  // Nothing silently discarded
  // ===========================================================================

  describe('mapping transparency', () => {
    it('reports an unrecognised column rather than dropping it', async () => {
      const response = await preview({
        csv: `Customer Name,Mobile No.,Internal Ref\nDana,${mobile()},ABC-1`,
      }).expect(200);

      expect(response.body.data.unmapped).toContain('Internal Ref');
      const column = (response.body.data.columns as { header: string; note: string }[]).find(
        (candidate) => candidate.header === 'Internal Ref',
      );
      expect(column?.note).toMatch(/Not recognised/);
    });

    it('does not pre-select a guessed column', async () => {
      const response = await preview({
        csv: `Customer Name,Mobile No.,Budget\nDana,${mobile()},250000`,
      }).expect(200);

      /*
       * "Budget" may be the deal value, a unit price or a per-kilo rate. The
       * old matcher pre-selected the guess, which is how a budget column
       * silently became the pipeline value for two thousand leads.
       */
      expect(response.body.data.mapping['Budget']).toBeUndefined();
      expect(response.body.data.needsConfirmation).toHaveLength(1);
      expect(response.body.data.needsConfirmation[0]).toMatchObject({
        header: 'Budget',
        field: 'estimatedValue',
        confidence: 'fuzzy',
      });
    });

    it('imports a guessed column once the caller confirms it', async () => {
      const number = mobile();

      await runImport({
        csv: `Customer Name,Mobile No.,Budget\nDana,${number},"2,50,000"`,
        mapping: {
          'Customer Name': 'firstName',
          'Mobile No.': 'mobile',
          Budget: 'estimatedValue',
        },
      }).expect(200);

      // Indian lakh grouping. `Number("2,50,000")` is NaN, so this row used to
      // be rejected with "is not a number" for a value that plainly is one.
      expect((await leadByMobile(number))?.estimatedValue?.toString()).toBe('250000');
    });

    it('reports a duplicated header', async () => {
      const response = await preview({
        csv: `Customer Name,Mobile No.,Mobile No.\nDana,${mobile()},${mobile()}`,
      }).expect(200);

      expect(response.body.data.duplicateHeaders).toContain('Mobile No.');
    });

    it('refuses an import whose mapping sends two columns to one field', async () => {
      const response = await runImport({
        csv: `Name,Phone,Cell\nDana,${mobile()},${mobile()}`,
        mapping: { Name: 'firstName', Phone: 'mobile', Cell: 'mobile' },
      }).expect(400);

      // Refused rather than resolved: which of two phone columns is the mobile
      // is not something the server can know, and letting one lose silently is
      // the class of defect this release removes.
      expect(JSON.stringify(response.body)).toMatch(/both map to mobile/);
    });

    it('refuses a mapping that names a field which does not exist', async () => {
      // A client guessing `"address"` instead of `"addressLine1"` used to have
      // the column filtered out silently and saw a successful import with no
      // addresses in it.
      const response = await runImport({
        csv: `Name,Phone,Street\nDana,${mobile()},12 High Street`,
        mapping: { Name: 'firstName', Phone: 'mobile', Street: 'address' },
      }).expect(400);

      // Asserted on the details array rather than the serialised envelope,
      // where every quote is backslash-escaped.
      expect(response.body.error.details.mapping).toContain('"address" is not a lead field');
    });

    it('refuses a mapping that names a column not in the file', async () => {
      await runImport({
        csv: `Name,Phone\nDana,${mobile()}`,
        mapping: { Name: 'firstName', Phone: 'mobile', Nope: 'city' },
      }).expect(400);
    });
  });

  // ===========================================================================
  // Robustness
  // ===========================================================================

  describe('file robustness', () => {
    it('reads a semicolon-delimited export', async () => {
      const number = mobile();

      await runImport({
        csv: `Customer Name;Mobile No.;City\nDana;${number};Pune`,
      }).expect(200);

      /*
       * Excel writes semicolons in every locale where the comma is the decimal
       * separator. Such a file used to parse as ONE column per row, so the
       * import failed with "no column mapped to firstName" — which says nothing
       * about the real problem, on a file that looks perfectly fine in Excel.
       */
      expect((await leadByMobile(number))?.city).toBe('Pune');
    });

    it('reads a file with a BOM and CRLF line endings', async () => {
      const number = mobile();

      await runImport({
        csv: `${String.fromCharCode(0xfeff)}Customer Name,Mobile No.\r\nDana,${number}\r\n`,
      }).expect(200);

      expect(await leadByMobile(number)).not.toBeNull();
    });

    it('keeps Marathi text intact', async () => {
      const number = mobile();

      await runImport({
        csv: `Customer Name,Mobile No.,City\nदाना व्हिटफील्ड,${number},पुणे`,
      }).expect(200);

      const lead = await leadByMobile(number);
      expect(lead?.firstName).toBe('दाना व्हिटफील्ड');
      expect(lead?.city).toBe('पुणे');
    });

    it('reads a day-first follow-up date as day-first', async () => {
      const number = mobile();

      await runImport({
        csv: `Customer Name,Mobile No.,Follow-up Date\nDana,${number},01/02/2027`,
      }).expect(200);

      /*
       * `new Date("01/02/2027")` is month-first in every JavaScript runtime, so
       * a file saying 1 February imported as 2 January — an eleven-month error
       * on a follow-up date, which surfaces as a reminder that never fires.
       */
      expect((await leadByMobile(number))?.nextFollowUpAt?.toISOString()).toBe(
        '2027-02-01T00:00:00.000Z',
      );
    });

    it('explains a row with more values than columns', async () => {
      const response = await preview({
        csv: `Customer Name,Mobile No.\nDana,${mobile()},extra,more`,
        defaultNextFollowUpAt: inDays(3),
      }).expect(200);

      // An unquoted comma shifts every later column, so the name lands in the
      // company field. Blaming a single field would send the user looking in
      // the wrong place.
      expect(response.body.data.rows[0].errors[0]).toMatch(/values but the header has/);
    });

    it('refuses a file that ends inside a quoted value, with a readable reason', async () => {
      const response = await preview({
        csv: `Customer Name,Notes\nDana,"unterminated`,
      }).expect(400);

      expect(JSON.stringify(response.body)).toMatch(/opened and never closed/);
    });
  });

  // ===========================================================================
  // Preview, errors and duplicates
  // ===========================================================================

  describe('preview', () => {
    it('writes nothing at all', async () => {
      const before = await activeLeadCount();

      await preview({
        csv: `Customer Name,Mobile No.\nDana,${mobile()}\nSam,${mobile()}`,
        defaultNextFollowUpAt: inDays(3),
      }).expect(200);

      // The contract preview exists to keep: a user must be able to check a
      // mapping without touching production records.
      expect(await activeLeadCount()).toBe(before);
    });

    it('returns every bad row as CSV, not just the ones on screen', async () => {
      // 30 rows, all invalid: more than the 20-row on-screen sample, which is
      // what made the old report unusable on a large file.
      const rows = Array.from({ length: 30 }, (_, index) => `Row${index},not-a-number`);

      const response = await preview({
        csv: ['Customer Name,Mobile No.', ...rows].join('\n'),
        defaultNextFollowUpAt: inDays(3),
      }).expect(200);

      expect(response.body.data.invalidRows).toBe(30);
      expect(response.body.data.rows).toHaveLength(20);

      const errorCsv = response.body.data.errorCsv as string;
      expect(errorCsv).toContain('Row');
      // All thirty, so the user can fix the source file from this download
      // alone rather than cross-referencing line numbers by hand.
      expect(errorCsv.trimEnd().split('\r\n')).toHaveLength(31);
      expect(errorCsv).toContain('Row29');
    });

    it('agrees with the import about which rows are valid', async () => {
      const csv = [
        'Customer Name,Mobile No.',
        `Good,${mobile()}`,
        `,${mobile()}`,
        'NoPhone,',
      ].join('\n');

      const previewResponse = await preview({ csv, defaultNextFollowUpAt: inDays(3) }).expect(200);
      const importResponse = await runImport({ csv }).expect(200);

      /*
       * They shared a validator but called it with different arguments — the
       * preview passed `missingRequired`, the import passed `[]` — so a row
       * could be counted valid by one and rejected by the other. The user saw
       * "2 valid" and then "1 created, 2 failed".
       */
      expect(previewResponse.body.data.validRows).toBe(importResponse.body.data.created);
      expect(previewResponse.body.data.invalidRows).toBe(importResponse.body.data.failed);
    });

    it('finds a duplicate by email as well as by mobile', async () => {
      const email = `${unique('dup')}@example.test`;

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Existing', email, nextFollowUpAt: inDays(1) })
        .expect(201);

      const response = await preview({
        csv: `Customer Name,Mobile No.,Email ID\nDana,${mobile()},${email}`,
        defaultNextFollowUpAt: inDays(3),
      }).expect(200);

      // A file where the same customer appears once with a number and once
      // with only an email used to import them twice: the check was
      // mobile-only while the database enforces both keys.
      expect(response.body.data.duplicateRows).toBe(1);
      expect(response.body.data.rows[0].duplicateOf).toMatchObject({
        kind: 'existing',
        matchedOn: 'email',
      });
    });

    it('matches an email duplicate regardless of case', async () => {
      const local = unique('casing');

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({
          firstName: 'Existing',
          email: `${local}@example.test`,
          nextFollowUpAt: inDays(1),
        })
        .expect(201);

      const response = await preview({
        csv: `Customer Name,Mobile No.,Email ID\nDana,${mobile()},${local.toUpperCase()}@EXAMPLE.TEST`,
        defaultNextFollowUpAt: inDays(3),
      }).expect(200);

      // The index keys on lower(email), so comparing raw strings here would
      // pass a row the database then refuses.
      expect(response.body.data.duplicateRows).toBe(1);
    });
  });

  // ===========================================================================
  // Duplicate strategy
  // ===========================================================================

  describe('duplicate handling', () => {
    it('skips a duplicate of an existing lead by default', async () => {
      const number = mobile();

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Existing', mobile: number, nextFollowUpAt: inDays(1) })
        .expect(201);

      const response = await runImport({
        csv: `Customer Name,Mobile No.\nDana,${number}`,
      }).expect(200);

      // The safe behaviour is the one you get by saying nothing: importing a
      // file that overlaps a live pipeline must not double every lead in it.
      expect(response.body.data).toMatchObject({ created: 0, skipped: 1 });
    });

    it('creates a second lead when the caller explicitly asks', async () => {
      const number = mobile();

      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Existing', mobile: number, nextFollowUpAt: inDays(1) })
        .expect(201);

      const response = await runImport({
        csv: `Customer Name,Mobile No.\nDana,${number}`,
        duplicateMode: 'CREATE_ANYWAY',
      }).expect(200);

      expect(response.body.data.created).toBe(1);
    });

    it('still skips a row repeated inside the file, even in CREATE_ANYWAY', async () => {
      const number = mobile();

      const response = await runImport({
        csv: `Customer Name,Mobile No.\nDana,${number}\nDana Again,${number}`,
        duplicateMode: 'CREATE_ANYWAY',
      }).expect(200);

      /*
       * CREATE_ANYWAY means "I know this customer is in the CRM and want a
       * second lead" — a deliberate choice about one existing record. It does
       * not mean "import the same row of this file twice", which is never what
       * anybody wants.
       */
      expect(response.body.data).toMatchObject({ created: 1, skipped: 1 });
    });

    it('refuses an unknown duplicate mode rather than guessing', async () => {
      await runImport({
        csv: `Customer Name,Mobile No.\nDana,${mobile()}`,
        duplicateMode: 'UPDATE_EXISTING',
      }).expect(400);
    });
  });

  // ===========================================================================
  // Batch tracking
  // ===========================================================================

  describe('import batches', () => {
    it('tags every created lead with the batch', async () => {
      const number = mobile();

      const response = await runImport({
        csv: `Customer Name,Mobile No.\nDana,${number}`,
        fileName: 'october-leads.csv',
      }).expect(200);

      const batchId = response.body.data.batchId as string;
      expect(batchId).toBeTruthy();
      // "Which leads came from that badly mapped file?" is one query now
      // instead of a manual hunt.
      expect((await leadByMobile(number))?.importBatchId).toBe(batchId);
    });

    it('reports the batch with its counts, mapping and file name', async () => {
      const response = await runImport({
        csv: `Customer Name,Mobile No.\nDana,${mobile()}\nBad,not-a-number`,
        fileName: 'november-leads.csv',
      }).expect(200);

      const batch = await ctx
        .http()
        .get(`/api/v1/leads/import/batches/${response.body.data.batchId as string}`)
        .set(owner())
        .expect(200);

      expect(batch.body.data).toMatchObject({
        fileName: 'november-leads.csv',
        totalRows: 2,
        created: 1,
        failed: 1,
        activeLeads: 1,
        deactivatedLeads: 0,
      });
      // The mapping, because "how did the address end up in the wrong field"
      // is the question this record exists to answer.
      expect(batch.body.data.mapping['Mobile No.']).toBe('mobile');
      expect(batch.body.data.importedBy.id).toBe(ctx.orgA.owner.id);
    });

    it('lists past batches, newest first', async () => {
      await runImport({
        csv: `Customer Name,Mobile No.\nDana,${mobile()}`,
        fileName: 'latest.csv',
      }).expect(200);

      const response = await ctx
        .http()
        .get('/api/v1/leads/import/batches')
        .set(owner())
        .expect(200);

      expect(response.body.data[0].fileName).toBe('latest.csv');
    });

    it('lists exactly the leads one batch created', async () => {
      const numbers = [mobile(), mobile()];

      const response = await runImport({
        csv: [
          'Customer Name,Mobile No.',
          ...numbers.map((number, index) => `Imported${index},${number}`),
        ].join('\n'),
      }).expect(200);

      const leads = await ctx
        .http()
        .get(`/api/v1/leads?importBatchId=${response.body.data.batchId as string}`)
        .set(owner())
        .expect(200);

      expect(leads.body.data.items).toHaveLength(2);
      expect(leads.body.data.total).toBe(2);
    });

    it('does not show another organization its batches', async () => {
      await runImport({
        csv: `Customer Name,Mobile No.\nDana,${mobile()}`,
        fileName: 'org-a-only.csv',
      }).expect(200);

      const response = await ctx
        .http()
        .get('/api/v1/leads/import/batches')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);

      const names = (response.body.data as { fileName: string | null }[]).map((b) => b.fileName);
      expect(names).not.toContain('org-a-only.csv');
    });

    it('refuses a sales rep the batch list', async () => {
      await ctx
        .http()
        .get('/api/v1/leads/import/batches')
        .set(auth(ctx.orgA.rep.accessToken))
        .expect(403);
    });
  });

  // ===========================================================================
  // Mapping templates
  // ===========================================================================

  describe('saved mappings', () => {
    it('saves, lists and reuses a mapping', async () => {
      const name = unique('Tally export');

      await ctx
        .http()
        .post('/api/v1/leads/import/mappings')
        .set(owner())
        .send({ name, mapping: { 'Party Name': 'firstName', 'Mobile': 'mobile' } })
        .expect(201);

      const list = await ctx
        .http()
        .get('/api/v1/leads/import/mappings')
        .set(owner())
        .expect(200);

      const saved = (list.body.data as { name: string; mapping: Record<string, string> }[]).find(
        (template) => template.name === name,
      );
      expect(saved?.mapping['Party Name']).toBe('firstName');
    });

    it('replaces a template of the same name rather than adding another', async () => {
      const name = unique('Monthly');

      await ctx
        .http()
        .post('/api/v1/leads/import/mappings')
        .set(owner())
        .send({ name, mapping: { A: 'firstName' } })
        .expect(201);
      await ctx
        .http()
        .post('/api/v1/leads/import/mappings')
        .set(owner())
        .send({ name, mapping: { B: 'firstName' } })
        .expect(201);

      const list = await ctx.http().get('/api/v1/leads/import/mappings').set(owner()).expect(200);
      const matching = (list.body.data as { name: string }[]).filter((t) => t.name === name);

      // Refining one mapping over three attempts should leave one template,
      // not three called "Monthly (2)".
      expect(matching).toHaveLength(1);
    });

    it('refuses a template naming a field that does not exist', async () => {
      await ctx
        .http()
        .post('/api/v1/leads/import/mappings')
        .set(owner())
        .send({ name: unique('Bad'), mapping: { A: 'address' } })
        .expect(400);
    });

    it('does not let one organization see or delete another’s templates', async () => {
      const name = unique('Private');

      const created = await ctx
        .http()
        .post('/api/v1/leads/import/mappings')
        .set(owner())
        .send({ name, mapping: { A: 'firstName' } })
        .expect(201);

      const theirs = await ctx
        .http()
        .get('/api/v1/leads/import/mappings')
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(200);
      expect((theirs.body.data as { name: string }[]).map((t) => t.name)).not.toContain(name);

      // 404, not 403: confirming the id exists would make this an enumeration
      // oracle for another tenant's templates.
      await ctx
        .http()
        .delete(`/api/v1/leads/import/mappings/${created.body.data.id as string}`)
        .set(auth(ctx.orgB.owner.accessToken))
        .expect(404);
    });
  });

  // ===========================================================================
  // Isolation and partial failure
  // ===========================================================================

  describe('safety', () => {
    it('does not let an invalid row corrupt the rows around it', async () => {
      const good = [mobile(), mobile()];

      const response = await runImport({
        csv: [
          'Customer Name,Mobile No.,City',
          `First,${good[0] as string},Pune`,
          'Broken,not-a-number,Nagpur',
          `Second,${good[1] as string},Nashik`,
        ].join('\n'),
      }).expect(200);

      expect(response.body.data).toMatchObject({ created: 2, failed: 1 });
      // Rows are written one at a time deliberately: a multi-thousand-row
      // transaction would hold locks on a live tenant's leads table for the
      // whole run, and one bad row would roll back every good one.
      expect((await leadByMobile(good[0] as string))?.city).toBe('Pune');
      expect((await leadByMobile(good[1] as string))?.city).toBe('Nashik');
    });

    it('refuses to assign imported leads to another organization’s member', async () => {
      await runImport({
        csv: `Customer Name,Mobile No.\nDana,${mobile()}`,
        assignedToId: ctx.orgB.owner.id,
      }).expect(400);
    });

    it('imports into the caller’s own tenant only', async () => {
      const number = mobile();

      await runImport({ csv: `Customer Name,Mobile No.\nDana,${number}` }).expect(200);

      const inOrgB = await asSystem('e2e cross-tenant check', () =>
        prisma().lead.count({
          where: { organizationId: ctx.orgB.id, mobile: toFixtureE164(number) },
        }),
      );
      expect(inOrgB).toBe(0);
    });

    it('refuses an import whose mapping omits a required field', async () => {
      const response = await runImport({
        csv: `Internal Ref,Notes\nABC,hello`,
      }).expect(400);

      expect(JSON.stringify(response.body)).toMatch(/no column is mapped to/);
    });
  });
});
