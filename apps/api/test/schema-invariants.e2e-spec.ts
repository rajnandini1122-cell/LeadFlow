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

  const createOrgOfType = (slug: string, type: 'CUSTOMER' | 'INTERNAL') =>
    attempt(
      `insert into organizations (name, slug, organization_type, updated_at)
       values ($1, $2, $3::organization_type, now())`,
      [slug, slug, type],
    );

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

  describe('one platform organization (organizations_single_internal_uniq)', () => {
    /**
     * At most ONE organization may be INTERNAL, and the database says so.
     *
     * Tested here, against raw `pg`, for the reason this whole file exists: a
     * constraint violation through Prisma drops the connection on the
     * in-process PGlite the development suite uses, so refusals are asserted
     * with a driver that survives them.
     *
     * The stake is worth stating. A second platform organization is not a
     * duplicate record — it is a second set of keys to the building, because
     * its owner would hold PLATFORM_OWNER over every customer. A bootstrap run
     * twice with a different name is exactly how that would happen, so the
     * guarantee belongs in the schema rather than in the command.
     */
    const insertInternal = (slug: string) =>
      attempt(
        `insert into organizations (name, slug, organization_type, updated_at)
         values ($1, $2, 'INTERNAL'::organization_type, now())`,
        [slug, slug],
      );

    /*
     * THE SINGLETON PROBLEM, and why both hooks are here.
     *
     * This index is GLOBAL: at most one INTERNAL row may exist in the entire
     * database. Three suites in this project legitimately want to create "the"
     * platform organization, and the e2e database is shared between them — so
     * whichever runs second is refused, correctly, by the index.
     *
     * The suites run sequentially (`--runInBand`, maxWorkers 1), so the
     * deterministic answer is for each one to CLAIM the slot on the way in and
     * RELEASE it on the way out. Clearing only its own rows afterwards is not
     * enough: this suite would still fail if it ran after one of the others.
     *
     * Before this, the full suite passed by ordering luck. That is worth naming
     * — a green run that depends on which file Jest happens to schedule first
     * is a run that will go red on somebody else's machine for no reason they
     * can see.
     */
    const clearInternalOrganizations = () =>
      withClient(async (client) => {
        await client.query(
          `delete from organization_users where organization_id in
             (select id from organizations
               where organization_type = 'INTERNAL'::organization_type)`,
        );
        await client.query(
          `delete from organization_settings where organization_id in
             (select id from organizations
               where organization_type = 'INTERNAL'::organization_type)`,
        );
        await client.query(
          `delete from organizations
             where organization_type = 'INTERNAL'::organization_type`,
        );
      });

    beforeAll(clearInternalOrganizations);
    afterAll(clearInternalOrganizations);

    it('accepts the first internal organization', async () => {
      expect(await insertInternal(`internal-first-${Date.now()}`)).toBe('OK');
    });

    it('refuses a second one', async () => {
      const refusal = await insertInternal(`internal-second-${Date.now()}`);

      // The index name, not merely "some error" — so a future migration that
      // dropped it would fail here rather than silently allowing two.
      expect(refusal).toBe('organizations_single_internal_uniq');
    });

    it('still accepts any number of CUSTOMER organizations', async () => {
      /*
       * The other half of a PARTIAL index: customers are not in it at all.
       * An index that accidentally covered every row would refuse the second
       * customer who ever signed up — a total outage with a very confusing
       * error, so it is worth an explicit test.
       */
      const stamp = Date.now();
      expect(await createOrgOfType(`customer-a-${stamp}`, 'CUSTOMER')).toBe('OK');
      expect(await createOrgOfType(`customer-b-${stamp}`, 'CUSTOMER')).toBe('OK');
      expect(await createOrgOfType(`customer-c-${stamp}`, 'CUSTOMER')).toBe('OK');
    });

    it('defaults an organization with no stated type to CUSTOMER', async () => {
      // What makes the column safe to add to a running database: every existing
      // row, and every future registration, is a customer without saying so.
      const slug = `defaulted-${Date.now()}`;
      await createOrg(slug);

      const type = await withClient(async (client) => {
        const result = await client.query(
          'select organization_type from organizations where slug = $1',
          [slug],
        );
        return result.rows[0].organization_type as string;
      });

      expect(type).toBe('CUSTOMER');
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

  /**
   * Territories: one live owner per place, and selectors that mean something.
   *
   * These are the objects the resolver's determinism rests on, and none of
   * them can be expressed in schema.prisma — a partial unique index and three
   * CHECK constraints, all written by hand in the migration. Every assertion
   * here deliberately provokes a SQL error, which is why the file uses raw
   * `pg` on a fresh connection rather than Prisma.
   */
  describe('territory coverage', () => {
    const insertTerritory = async (organizationId: string, name: string): Promise<string> =>
      withClient(async (client) => {
        // name_key is passed rather than computed in SQL: reusing $2 inside
        // lower() leaves Postgres unable to deduce one type for the parameter.
        const result = await client.query(
          `insert into territories (organization_id, name, name_key, updated_at)
           values ($1, $2, $3, now()) returning id`,
          [organizationId, name, name.toLowerCase()],
        );
        return result.rows[0].id as string;
      });

    const insertCoverage = (
      organizationId: string,
      territoryId: string,
      columns: {
        type: string;
        country: string;
        stateKey?: string | null;
        stateName?: string | null;
        cityKey?: string | null;
        cityName?: string | null;
        postalKey?: string | null;
        postal?: string | null;
        key: string;
      },
    ) =>
      attempt(
        `insert into territory_coverage
           (organization_id, territory_id, type, country_code,
            state_key, state_name, city_key, city_name,
            postal_code_key, postal_code, coverage_key)
         values ($1, $2, $3::territory_coverage_type, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          organizationId,
          territoryId,
          columns.type,
          columns.country,
          columns.stateKey ?? null,
          columns.stateName ?? null,
          columns.cityKey ?? null,
          columns.cityName ?? null,
          columns.postalKey ?? null,
          columns.postal ?? null,
          columns.key,
        ],
      );

    it('refuses two live territories claiming the same place', async () => {
      const organizationId = await createOrg(`terr-owner-${Date.now()}`);
      const first = await insertTerritory(organizationId, 'First');
      const second = await insertTerritory(organizationId, 'Second');

      expect(
        await insertCoverage(organizationId, first, {
          type: 'STATE',
          country: 'IN',
          stateKey: 'maharashtra',
          stateName: 'Maharashtra',
          key: 'STATE|IN|maharashtra',
        }),
      ).toBe('OK');

      // Without this the resolver would have two answers for one place, and
      // which it gave would depend on row order.
      expect(
        await insertCoverage(organizationId, second, {
          type: 'STATE',
          country: 'IN',
          stateKey: 'maharashtra',
          stateName: 'Maharashtra',
          key: 'STATE|IN|maharashtra',
        }),
      ).toBe('territory_coverage_active_key_uniq');
    });

    it('lets two organizations cover the same place', async () => {
      const a = await createOrg(`terr-a-${Date.now()}`);
      const b = await createOrg(`terr-b-${Date.now()}`);
      const territoryA = await insertTerritory(a, 'Theirs');
      const territoryB = await insertTerritory(b, 'Theirs');

      // The index is per tenant. Two competitors may both sell into Brazil.
      expect(
        await insertCoverage(a, territoryA, { type: 'COUNTRY', country: 'BR', key: 'COUNTRY|BR' }),
      ).toBe('OK');
      expect(
        await insertCoverage(b, territoryB, { type: 'COUNTRY', country: 'BR', key: 'COUNTRY|BR' }),
      ).toBe('OK');
    });

    it('refuses a coverage row whose tenant disagrees with its territory', async () => {
      const a = await createOrg(`terr-x-${Date.now()}`);
      const b = await createOrg(`terr-y-${Date.now()}`);
      const theirs = await insertTerritory(b, 'Theirs');

      // The composite foreign key carries the tenant into the key, so this is
      // refused by PostgreSQL rather than by a check somebody could forget.
      expect(
        await insertCoverage(a, theirs, { type: 'COUNTRY', country: 'DE', key: 'COUNTRY|DE' }),
      ).toBe('territory_coverage_territory_id_organization_id_fkey');
    });

    it('refuses selectors that do not mean anything', async () => {
      const organizationId = await createOrg(`terr-shape-${Date.now()}`);
      const territoryId = await insertTerritory(organizationId, 'Shapes');

      // A COUNTRY row with a city in it, or a POSTAL_CODE row with no pincode,
      // would make the resolver's specificity order meaningless.
      expect(
        await insertCoverage(organizationId, territoryId, {
          type: 'COUNTRY',
          country: 'IN',
          cityKey: 'pune',
          cityName: 'Pune',
          key: 'COUNTRY|IN',
        }),
      ).toBe('territory_coverage_shape_chk');

      expect(
        await insertCoverage(organizationId, territoryId, {
          type: 'POSTAL_CODE',
          country: 'IN',
          key: 'POSTAL|IN|411019',
        }),
      ).toBe('territory_coverage_shape_chk');

      expect(
        await insertCoverage(organizationId, territoryId, {
          type: 'STATE',
          country: 'IN',
          key: 'STATE|IN|maharashtra',
        }),
      ).toBe('territory_coverage_shape_chk');
    });

    it('refuses a comparison key with no display spelling', async () => {
      const organizationId = await createOrg(`terr-display-${Date.now()}`);
      const territoryId = await insertTerritory(organizationId, 'Display');

      // Otherwise the screen would show an administrator one thing while the
      // resolver matched another.
      expect(
        await insertCoverage(organizationId, territoryId, {
          type: 'CITY',
          country: 'IN',
          cityKey: 'pune',
          cityName: null,
          key: 'CITY|IN|*|pune',
        }),
      ).toBe('territory_coverage_display_chk');
    });

    it('lets a place be re-claimed once it has been released', async () => {
      const organizationId = await createOrg(`terr-move-${Date.now()}`);
      const first = await insertTerritory(organizationId, 'First');
      const second = await insertTerritory(organizationId, 'Second');

      await insertCoverage(organizationId, first, {
        type: 'COUNTRY',
        country: 'FR',
        key: 'COUNTRY|FR',
      });
      await withClient((client) =>
        client.query(`update territory_coverage set removed_at = now() where territory_id = $1`, [
          first,
        ]),
      );

      // PARTIAL on removed_at, so a selector may legitimately move between
      // territories — and the removed row stays as the record of where those
      // enquiries went.
      expect(
        await insertCoverage(organizationId, second, {
          type: 'COUNTRY',
          country: 'FR',
          key: 'COUNTRY|FR',
        }),
      ).toBe('OK');
    });

    it('keeps the objects the territory resolver depends on', async () => {
      const indexes = await withClient(async (client) => {
        const result = await client.query(
          `select indexname from pg_indexes where schemaname='public' and tablename in ('territories','territory_coverage','assignment_rules')`,
        );
        return (result.rows as { indexname: string }[]).map((row) => row.indexname);
      });

      expect(indexes).toEqual(
        expect.arrayContaining([
          'territories_org_name_key_active_uniq',
          'territories_id_organization_id_key',
          'territory_coverage_active_key_uniq',
          'assignment_rules_org_territory_status_idx',
          // Unchanged from J4, and asserted here so that widening
          // criteria_key cannot have quietly dropped them.
          'assignment_rules_active_criteria_uniq',
          'assignment_rules_active_priority_uniq',
          'assignment_rules_active_fallback_uniq',
        ]),
      );
    });

    it('leaves every existing criteria key in the one canonical format', async () => {
      const keys = await withClient(async (client) => {
        const result = await client.query(`select criteria_key from assignment_rules`);
        return (result.rows as { criteria_key: string }[]).map((row) => row.criteria_key);
      });

      /*
       * The migration's promise, checked against whatever the suite has
       * written by now. Two formats living side by side is the failure this
       * guards: the active-criteria unique index compares strings, so an old
       * two-segment key and a new three-segment key for the same criteria
       * would read as two different rules and both be allowed active.
       */
      for (const key of keys) {
        expect(key).toMatch(/^source=[^|]*\|product=[^|]*\|territory=[^|]*$/);
      }
    });
  });

  /**
   * Round-robin state, and the enquiry queue that feeds it.
   *
   * The rotation is `sequence % candidates.length`, so a negative sequence
   * would index outside the array rather than wrapping — in PostgreSQL a
   * negative left operand yields a negative remainder. And two cursor rows for
   * one team would be two rotations, with row order deciding which answered.
   */
  describe('team assignment cursors', () => {
    const insertTeam = async (organizationId: string, name: string): Promise<string> =>
      withClient(async (client) => {
        const result = await client.query(
          `insert into teams (organization_id, name, name_key, updated_at)
           values ($1, $2, $3, now()) returning id`,
          [organizationId, name, name.toLowerCase()],
        );
        return result.rows[0].id as string;
      });

    const insertCursor = (organizationId: string, teamId: string, sequence: number) =>
      attempt(
        `insert into team_assignment_cursors (organization_id, team_id, sequence, updated_at)
         values ($1, $2, $3, now())`,
        [organizationId, teamId, sequence],
      );

    it('refuses a second cursor for one team', async () => {
      const organizationId = await createOrg(`cursor-${Date.now()}`);
      const teamId = await insertTeam(organizationId, 'Rotating');

      expect(await insertCursor(organizationId, teamId, 0)).toBe('OK');
      expect(await insertCursor(organizationId, teamId, 0)).toBe(
        'team_assignment_cursors_team_id_key',
      );
    });

    it('refuses a negative sequence', async () => {
      const organizationId = await createOrg(`cursor-neg-${Date.now()}`);
      const teamId = await insertTeam(organizationId, 'Backwards');

      expect(await insertCursor(organizationId, teamId, -1)).toBe(
        'team_assignment_cursors_sequence_chk',
      );
    });

    it('refuses a cursor whose tenant disagrees with its team', async () => {
      const a = await createOrg(`cursor-a-${Date.now()}`);
      const b = await createOrg(`cursor-b-${Date.now()}`);
      const theirs = await insertTeam(b, 'Theirs');

      // The composite foreign key carries the tenant into the key, so one
      // organization cannot create a rotation over another's team.
      expect(await insertCursor(a, theirs, 0)).toBe(
        'team_assignment_cursors_team_id_organization_id_fkey',
      );
    });

    it('refuses a negative processing attempt count', async () => {
      const organizationId = await createOrg(`intake-neg-${Date.now()}`);

      const result = await attempt(
        `insert into integration_intakes
           (organization_id, source, external_event_id, event_type, payload_hash,
            processing_attempts, updated_at)
         values ($1, 'WEBSITE', $2, 'ENQUIRY', $3, -1, now())`,
        [organizationId, `evt-${Date.now()}`, 'c'.repeat(64)],
      );

      expect(result).toBe('integration_intakes_processing_attempts_chk');
    });

    it('refuses a first-response SLA outside a practical range', async () => {
      const organizationId = await createOrg(`sla-${Date.now()}`);

      // Zero would mean "already overdue the instant it arrives", and the
      // upper bound stops a typo turning a one-hour promise into a fortnight.
      const zero = await attempt(
        `insert into organization_settings
           (organization_id, website_intake_first_follow_up_minutes, updated_at)
         values ($1, 0, now())`,
        [organizationId],
      );
      expect(zero).toBe('organization_settings_first_follow_up_minutes_chk');

      const tooLong = await attempt(
        `insert into organization_settings
           (organization_id, website_intake_first_follow_up_minutes, updated_at)
         values ($1, 99999, now())`,
        [organizationId],
      );
      expect(tooLong).toBe('organization_settings_first_follow_up_minutes_chk');
    });

    it('keeps the objects the pipeline depends on', async () => {
      const indexes = await withClient(async (client) => {
        const result = await client.query(
          `select indexname from pg_indexes where schemaname='public' and tablename in ('team_assignment_cursors','integration_intakes','leads')`,
        );
        return (result.rows as { indexname: string }[]).map((row) => row.indexname);
      });

      expect(indexes).toEqual(
        expect.arrayContaining([
          'team_assignment_cursors_team_id_key',
          'team_assignment_cursors_team_id_organization_id_key',
          // The claim query: what is waiting ANYWHERE, oldest first.
          'integration_intakes_status_received_idx',
          // Lets an intake point a composite key at the lead it became.
          'leads_id_organization_id_key',
        ]),
      );
    });
  });
});
