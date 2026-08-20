import { Client } from 'pg';

/**
 * Guards the database objects that schema.prisma cannot express.
 *
 * Prisma has no representation for CHECK constraints, partial indexes or
 * triggers, so they live in raw SQL inside the migration. That means a future
 * `prisma migrate dev` could generate a migration that drops one without
 * anybody noticing. These tests are the safety net: if an invariant disappears,
 * CI fails instead of the guarantee quietly evaporating.
 *
 * Raw `pg` rather than Prisma, and a fresh connection per assertion, because
 * PGlite's socket server drops the connection on any SQL error — and every
 * assertion here deliberately provokes one.
 */
describe('Database invariants', () => {
  const connectionString = () => process.env['DATABASE_URL'] as string;

  /**
   * Opens a connection, retrying while PGlite's single slot is still held by
   * another spec file's application. Against a real Postgres the first attempt
   * always succeeds.
   */
  async function connect(attempts = 25): Promise<Client> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const client = new Client({ connectionString: connectionString(), ssl: false });
      // Without a listener, an async socket error becomes an unhandled
      // rejection that fails an unrelated test.
      client.on('error', () => undefined);

      try {
        await client.connect();
        return client;
      } catch (error) {
        lastError = error;
        await client.end().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }

    throw lastError;
  }

  async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Runs SQL and reports the Postgres error code, or 'OK'. */
  async function attempt(sql: string, params: unknown[] = []): Promise<string> {
    return withClient(async (client) => {
      try {
        await client.query(sql, params);
        return 'OK';
      } catch (error) {
        const pgError = error as { constraint?: string; code?: string };
        return pgError.constraint ?? pgError.code ?? 'ERROR';
      }
    });
  }

  async function createOrg(slug: string): Promise<string> {
    return withClient(async (client) => {
      const result = await client.query(
        `insert into organizations (name, slug, updated_at) values ($1, $2, now()) returning id`,
        [slug, slug],
      );
      return result.rows[0].id as string;
    });
  }

  const insertLead = (
    organizationId: string,
    leadNumber: string,
    status: string,
    mobile: string | null,
    nextFollowUpAt: 'now' | null,
  ) =>
    attempt(
      `insert into leads (organization_id, lead_number, status, mobile, next_follow_up_at, updated_at)
       values ($1, $2, $3::lead_status, $4, ${nextFollowUpAt === 'now' ? 'now()' : 'null'}, now())`,
      [organizationId, leadNumber, status, mobile],
    );

  // ---------------------------------------------------------------------------

  describe('uuidv7()', () => {
    it('sets the version and variant bits', async () => {
      const ids = await withClient(async (client) => {
        const result = await client.query(
          'select uuidv7() as id from generate_series(1, 50)',
        );
        return (result.rows as { id: string }[]).map((row) => row.id);
      });

      for (const id of ids) {
        expect(id[14]).toBe('7');
        expect(parseInt(id[19] as string, 16) & 0b1100).toBe(0b1000);
      }
    });

    it('generates time-ordered ids', async () => {
      // Two separate statements with a real gap between them. Evaluation order
      // of several function calls WITHIN one SELECT is not guaranteed, so
      // `select uuidv7(), pg_sleep(...), uuidv7()` is a flaky way to assert
      // ordering — it can and does return b <= a.
      const first = await withClient(async (client) =>
        (await client.query('select uuidv7() as id')).rows[0].id as string,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const second = await withClient(async (client) =>
        (await client.query('select uuidv7() as id')).rows[0].id as string,
      );

      // The ordering property is the whole reason for choosing v7: it keeps
      // index inserts appending rather than scattering.
      expect(first < second).toBe(true);
    });
  });

  describe('NO LEAD LEFT BEHIND (leads_active_requires_followup)', () => {
    let orgId: string;

    beforeAll(async () => {
      orgId = await createOrg(`inv-followup-${Date.now()}`);
    });

    it('rejects an ACTIVE lead with no next follow-up', async () => {
      const result = await insertLead(orgId, 'CHK-001', 'NEW', null, null);
      expect(result).toBe('leads_active_requires_followup');
    });

    it.each(['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATION'])(
      'rejects status %s with no next follow-up',
      async (status) => {
        const result = await insertLead(orgId, `CHK-${status}`, status, null, null);
        expect(result).toBe('leads_active_requires_followup');
      },
    );

    it('accepts an ACTIVE lead that has one', async () => {
      const result = await insertLead(orgId, 'CHK-002', 'NEW', null, 'now');
      expect(result).toBe('OK');
    });

    it.each(['WON', 'LOST'])('exempts terminal status %s', async (status) => {
      const result = await insertLead(orgId, `CHK-${status}`, status, null, null);
      expect(result).toBe('OK');
    });
  });

  describe('duplicate lead detection (leads_org_mobile_uniq)', () => {
    it('blocks a second active lead with the same mobile in the same organization', async () => {
      const orgId = await createOrg(`inv-dup-${Date.now()}`);

      expect(await insertLead(orgId, 'DUP-001', 'NEW', '9800000001', 'now')).toBe('OK');
      expect(await insertLead(orgId, 'DUP-002', 'NEW', '9800000001', 'now')).toBe(
        'leads_org_mobile_uniq',
      );
    });

    it('allows the same mobile in a DIFFERENT organization', async () => {
      const stamp = Date.now();
      const orgOne = await createOrg(`inv-dup-a-${stamp}`);
      const orgTwo = await createOrg(`inv-dup-b-${stamp}`);

      expect(await insertLead(orgOne, 'DUP-101', 'NEW', '9800000002', 'now')).toBe('OK');

      // Two SMEs may both be talking to the same person. Uniqueness is per
      // tenant, never global.
      expect(await insertLead(orgTwo, 'DUP-101', 'NEW', '9800000002', 'now')).toBe('OK');
    });

    it('frees the mobile once a lead is LOST', async () => {
      const orgId = await createOrg(`inv-lost-${Date.now()}`);

      expect(await insertLead(orgId, 'LOST-001', 'NEW', '9800000003', 'now')).toBe('OK');
      expect(
        await attempt(
          `update leads set status='LOST', lost_at=now() where organization_id=$1 and mobile='9800000003'`,
          [orgId],
        ),
      ).toBe('OK');

      // A previously lost enquiry may legitimately come back.
      expect(await insertLead(orgId, 'LOST-002', 'NEW', '9800000003', 'now')).toBe('OK');
    });
  });

  describe('append-only timeline', () => {
    it('refuses UPDATE on lead_activities', async () => {
      const orgId = await createOrg(`inv-append-${Date.now()}`);
      expect(await insertLead(orgId, 'APP-001', 'NEW', '9800000004', 'now')).toBe('OK');

      const leadId = await withClient(async (client) => {
        const result = await client.query(
          `select id from leads where organization_id=$1 limit 1`,
          [orgId],
        );
        return result.rows[0].id as string;
      });

      expect(
        await attempt(
          `insert into lead_activities (organization_id, lead_id, activity_type)
           values ($1, $2, 'LEAD_CREATED')`,
          [orgId, leadId],
        ),
      ).toBe('OK');

      // Sales history must not be rewritable — not by a bug, not by a console
      // session (spec §9).
      const tampered = await attempt(
        `update lead_activities set description='tampered' where lead_id=$1`,
        [leadId],
      );
      // 23001 = restrict_violation, the SQLSTATE the trigger raises.
      expect(tampered).toBe('23001');
    });
  });

  describe('required indexes', () => {
    it('keeps every organization_id-first index that scoped queries depend on', async () => {
      const indexes = await withClient(async (client) => {
        const result = await client.query(
          `select indexname from pg_indexes where schemaname='public' and tablename in ('leads','lead_activities','organization_users','sessions')`,
        );
        return (result.rows as { indexname: string }[]).map((row) => row.indexname);
      });

      expect(indexes).toEqual(
        expect.arrayContaining([
          'leads_org_mobile_uniq',
          'leads_followup_sweep_idx',
          'leads_organization_id_status_idx',
          'leads_organization_id_assigned_to_status_idx',
        ]),
      );
    });
  });
});
