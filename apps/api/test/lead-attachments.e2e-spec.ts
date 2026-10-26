import { randomUUID } from 'node:crypto';
import { createTestContext, type TestContext } from './helpers/test-app';
import { fixtureMobile } from './helpers/phone-fixtures';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';

/**
 * Files on a lead — quotations, invoices, photos — and the quotation's
 * effect on the lead: attaching one marked as sent moves the stage forward
 * and puts the lead in Awaiting response, in the same transaction as the file.
 */
describe('Lead attachments', () => {
  let ctx: TestContext;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const owner = () => auth(ctx.orgA.owner.accessToken);
  const rep = () => auth(ctx.orgA.rep.accessToken);
  const otherOrg = () => auth(ctx.orgB.owner.accessToken);
  const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString();
  const prisma = () => ctx.app.get(PrismaService).client;
  const asSystem = async <T>(reason: string, run: () => Promise<T>): Promise<T> =>
    ctx.app.get(TenantContextService).runAsSystem(reason, run);

  const pdf = (text = 'quote'): Buffer => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);
  const png = (): Buffer =>
    Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000100' +
        '05fe02fea70000000049454e44ae426082',
      'hex',
    );

  const createLead = async (body: Record<string, unknown> = {}): Promise<string> =>
    (
      await ctx
        .http()
        .post('/api/v1/leads')
        .set(owner())
        .send({ firstName: 'Files', mobile: fixtureMobile(), assignedToId: ctx.orgA.owner.id, nextFollowUpAt: inDays(1), ...body })
        .expect(201)
    ).body.data.id as string;

  const upload = (
    leadId: string,
    file: Buffer,
    name: string,
    fields: Record<string, string> = { kind: 'DOCUMENT' },
    headers: Record<string, string> = owner(),
  ) => {
    let req = ctx.http().post(`/api/v1/leads/${leadId}/attachments`).set(headers);
    for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
    return req.attach('file', file, name);
  };

  const list = async (leadId: string, headers = owner()) =>
    (await ctx.http().get(`/api/v1/leads/${leadId}/attachments`).set(headers).expect(200)).body.data as {
      id: string;
      kind: string;
      fileName: string;
      mimeType: string;
      amount: string | null;
      uploadedBy: { fullName: string } | null;
      data?: unknown;
    }[];

  const activities = async (leadId: string) =>
    asSystem('e2e timeline', () =>
      prisma().leadActivity.findMany({
        where: { leadId },
        select: { activityType: true, description: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('attaches a file, lists it without its bytes, and downloads it intact', async () => {
    const leadId = await createLead();
    const bytes = pdf('intact');
    const res = await upload(leadId, bytes, 'Price list.pdf', { kind: 'DOCUMENT', note: 'Spring catalogue' }).expect(201);
    const attachment = res.body.data.attachment as { id: string; fileName: string; mimeType: string };
    expect(attachment).toMatchObject({ fileName: 'Price list.pdf', mimeType: 'application/pdf' });

    const rows = await list(leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('data');
    expect(rows[0]?.uploadedBy?.fullName).toBeTruthy();

    const download = await ctx
      .http()
      .get(`/api/v1/leads/${leadId}/attachments/${attachment.id}/download`)
      .set(owner())
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(download.body as Buffer, bytes)).toBe(0);
    expect(download.headers['content-disposition']).toMatch(/^attachment;/);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['content-security-policy']).toMatch(/sandbox/);
  });

  it('decides the type from the bytes, not the name', async () => {
    const leadId = await createLead();
    // An HTML page named like a PDF is refused…
    await upload(leadId, Buffer.from('<html><script>alert(1)</script></html>'), 'quote.pdf').expect(400);
    // …an executable named like an image too.
    await upload(leadId, Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'photo.png').expect(400);
    // A real PNG named .exe is stored as the PNG it is.
    const res = await upload(leadId, png(), 'sample.exe', { kind: 'SAMPLE_PHOTO' }).expect(201);
    expect(res.body.data.attachment).toMatchObject({ mimeType: 'image/png', fileName: 'sample.png', isImage: true });
  });

  it('refuses a file over 10 MB', async () => {
    const leadId = await createLead();
    const big = Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const res = await upload(leadId, big, 'huge.pdf');
    expect([400, 413]).toContain(res.status);
    expect(await list(leadId)).toHaveLength(0);
  });

  it('refuses an upload with no file, and "sent" on anything but a quotation', async () => {
    const leadId = await createLead();
    await ctx.http().post(`/api/v1/leads/${leadId}/attachments`).set(owner()).field('kind', 'QUOTATION').expect(400);
    await upload(leadId, pdf(), 'invoice.pdf', { kind: 'INVOICE', markQuotationSent: 'true' }).expect(400);
    await upload(leadId, pdf(), 'x.pdf', { kind: 'NOT_A_KIND' }).expect(400);
  });

  it('a quotation marked sent moves the lead to Quotation sent and into Awaiting response', async () => {
    const leadId = await createLead();
    const res = await upload(leadId, pdf('Q-104'), 'Quotation Q-104.pdf', {
      kind: 'QUOTATION',
      amount: '125000.50',
      markQuotationSent: 'true',
      note: '20 ft container, CIF Jebel Ali',
    }).expect(201);
    expect(res.body.data.leadStatus).toBe('QUOTATION_SENT');

    const lead = (await ctx.http().get(`/api/v1/leads/${leadId}`).set(owner()).expect(200)).body.data as { status: string };
    expect(lead.status).toBe('QUOTATION_SENT');
    expect((await list(leadId))[0]?.amount).toBe('125000.5');

    const awaiting = (await ctx.http().get('/api/v1/leads?awaiting=true&limit=100').set(owner()).expect(200)).body.data
      .items as { id: string }[];
    expect(awaiting.map((l) => l.id)).toContain(leadId);

    const timeline = await activities(leadId);
    const attached = timeline.find((a) => a.activityType === 'DOCUMENT_ATTACHED');
    expect(attached?.description).toMatch(/^Quotation attached: Quotation Q-104\.pdf/);
    expect(attached?.description).toMatch(/sent to the customer/);
    expect(timeline.some((a) => a.activityType === 'STATUS_CHANGED')).toBe(true);
  });

  it('never moves a later stage backwards', async () => {
    const leadId = await createLead();
    await asSystem('e2e: a lead already in negotiation', () => prisma().lead.update({ where: { id: leadId }, data: { status: 'NEGOTIATION' } }));
    const res = await upload(leadId, pdf(), 'revised.pdf', { kind: 'QUOTATION', markQuotationSent: 'true' }).expect(201);
    expect(res.body.data.leadStatus).toBe('NEGOTIATION');
  });

  it('one Idempotency-Key is one attachment', async () => {
    const leadId = await createLead();
    const key = randomUUID();
    const first = await upload(leadId, pdf(), 'a.pdf', { kind: 'INVOICE' }, { ...owner(), 'Idempotency-Key': key }).expect(201);
    const second = await upload(leadId, pdf(), 'a.pdf', { kind: 'INVOICE' }, { ...owner(), 'Idempotency-Key': key }).expect(201);
    expect(second.body.data.replayed).toBe(true);
    expect(second.body.data.attachment.id).toBe(first.body.data.attachment.id);
    expect(await list(leadId)).toHaveLength(1);
  });

  it('is invisible to another organization and to a rep who cannot see the lead', async () => {
    const leadId = await createLead();
    const id = (await upload(leadId, pdf(), 'private.pdf').expect(201)).body.data.attachment.id as string;

    for (const headers of [otherOrg(), rep()]) {
      await ctx.http().get(`/api/v1/leads/${leadId}/attachments`).set(headers).expect(404);
      await ctx.http().get(`/api/v1/leads/${leadId}/attachments/${id}/download`).set(headers).expect(404);
      await upload(leadId, pdf(), 'intruder.pdf', { kind: 'DOCUMENT' }, headers).expect(404);
      await ctx.http().delete(`/api/v1/leads/${leadId}/attachments/${id}`).set(headers).expect(404);
    }
    expect(await list(leadId)).toHaveLength(1);
  });

  it('the rep who owns the lead can attach to it', async () => {
    const leadId = await createLead({ assignedToId: ctx.orgA.rep.id });
    await upload(leadId, png(), 'sample.png', { kind: 'SAMPLE_PHOTO' }, rep()).expect(201);
    expect(await list(leadId, rep())).toHaveLength(1);
  });

  it('removing keeps the record, hides the file and says so on the timeline', async () => {
    const leadId = await createLead();
    const id = (await upload(leadId, pdf(), 'old.pdf').expect(201)).body.data.attachment.id as string;

    await ctx.http().delete(`/api/v1/leads/${leadId}/attachments/${id}`).set(owner()).expect(204);
    expect(await list(leadId)).toHaveLength(0);
    await ctx.http().get(`/api/v1/leads/${leadId}/attachments/${id}/download`).set(owner()).expect(404);
    await ctx.http().delete(`/api/v1/leads/${leadId}/attachments/${id}`).set(owner()).expect(404);

    const row = await asSystem('e2e', () => prisma().leadAttachment.findFirst({ where: { id }, select: { deletedAt: true } }));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect((await activities(leadId)).some((a) => a.activityType === 'DOCUMENT_REMOVED')).toBe(true);
  });
});
