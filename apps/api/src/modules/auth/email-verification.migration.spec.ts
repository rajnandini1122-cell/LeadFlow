import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the verification migration is allowed to claim about existing accounts.
 *
 * This reads the migration SQL as text rather than applying it, which is
 * unusual and deliberate. The statement under test runs exactly once, against a
 * production database, on a table full of real users — there is no fresh
 * database on which its effect can be observed, because by the time any test
 * database exists the migration has already run and there were no pre-existing
 * rows for it to touch.
 *
 * WHY IT IS PINNED AT ALL: this decision was already made wrong once. The first
 * version of the migration stamped `created_at`, on the reasoning that it read
 * as "verified no later than account creation". That fabricates a per-user
 * verification moment no event in this system ever produced, and backdates a
 * policy decision taken at rollout to a date before the policy existed —
 * leaving anybody auditing "when was this mailbox proven?" reading a specific,
 * plausible, false answer.
 *
 * The honest stamp is the rollout moment itself. One shared timestamp across
 * every grandfathered row is self-evidently a policy decision rather than
 * evidence, which is exactly what it is.
 */
describe('The email verification migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      'prisma',
      'migrations',
      '20260925090000_email_verification',
      'migration.sql',
    ),
    'utf8',
  );

  /** The one statement that writes to a table that already has rows in it. */
  const grandfatherStatement = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .find((line) => line.includes('UPDATE "users"'));

  it('grandfathers existing accounts so the release cannot lock everybody out', () => {
    /*
     * Without this statement the column is NULL for every existing row, and the
     * login enforcement shipped alongside it refuses every current user —
     * including the platform owner, who would then be unable to reach the
     * console needed to investigate.
     */
    expect(grandfatherStatement).toBeDefined();
    expect(grandfatherStatement).toContain('email_verified_at');
    expect(grandfatherStatement).toContain('IS NULL');
  });

  it('stamps the ROLLOUT moment, not each account’s creation date', () => {
    expect(grandfatherStatement).toContain('now()');

    // The regression guard. `created_at` here would assert a verification event
    // that never happened, per-user and backdated.
    expect(grandfatherStatement).not.toContain('created_at');
  });

  it('touches only rows that have no value yet', () => {
    // Re-running must not overwrite a real verification moment with the rollout
    // moment. The guard is what makes that impossible.
    expect(grandfatherStatement).toMatch(/WHERE\s+"email_verified_at"\s+IS NULL/);
  });

  it('says in the file itself that this is not evidence of verification', () => {
    /*
     * The comment is load-bearing. Somebody reading this column in five years
     * needs to know that pre-rollout values record a policy decision and not a
     * proven mailbox, and the migration is where they will look.
     */
    expect(sql).toMatch(/grandfather/i);
    expect(sql).toMatch(/does NOT claim|not.{0,40}verification event/i);
  });

  it('adds the column without dropping or rewriting anything', () => {
    // Additive only: one nullable column, one new table, indexes and a foreign
    // key. A destructive statement here would be applied to production data.
    expect(sql).toContain('ADD COLUMN "email_verified_at"');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
