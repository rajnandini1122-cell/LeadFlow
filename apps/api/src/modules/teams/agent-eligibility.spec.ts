import {
  ASSIGNABLE_ROLES,
  isAssignableRole,
  isEligibleForAssignment,
} from './agent-eligibility';
import { teamNameKey } from './team-name';

/**
 * Who future automatic assignment may route work to.
 *
 * One definition, tested here rather than at four call sites — the failure
 * this prevents is three copies of the rule that agree today and disagree
 * after the next change, which shows up as a salesperson who appears in a
 * picker and never receives anything.
 */
describe('isEligibleForAssignment', () => {
  const eligible = {
    membershipStatus: 'ACTIVE',
    role: 'SALES_REP' as const,
    assignmentEnabled: true,
    teamStatus: 'ACTIVE' as const,
  };

  it('accepts an active sales rep in an active team', () => {
    expect(isEligibleForAssignment(eligible)).toBe(true);
  });

  describe('organization membership is authoritative', () => {
    it.each(['SUSPENDED', 'REMOVED', 'INVITED'])(
      'refuses a %s membership however the team row is configured',
      (membershipStatus) => {
        /*
         * The team never overrides the organization. Somebody suspended on a
         * Friday must stop receiving work immediately, without anything having
         * to remember to go and edit their team rows — which is also why this
         * is computed rather than stored.
         */
        expect(isEligibleForAssignment({ ...eligible, membershipStatus })).toBe(false);
      },
    );
  });

  it('refuses a member whose assignment is paused', () => {
    // Leave, training, or a workload that is already too high. An operational
    // pause, and nothing more.
    expect(isEligibleForAssignment({ ...eligible, assignmentEnabled: false })).toBe(false);
  });

  it('refuses everybody in an archived team', () => {
    expect(isEligibleForAssignment({ ...eligible, teamStatus: 'ARCHIVED' })).toBe(false);
  });

  describe('which roles are candidates', () => {
    it('counts SALES_REP', () => {
      expect(isAssignableRole('SALES_REP')).toBe(true);
    });

    it.each(['OWNER', 'ADMIN', 'MANAGER'] as const)(
      'does NOT automatically count %s',
      (role) => {
        /*
         * Deliberate, and narrower than MANUAL assignment on purpose.
         *
         * A person can still hand a lead to anyone active — LeadsService has
         * always allowed that and this phase does not touch it. What is
         * refused here is a ROUTING policy nobody chose: quietly giving the
         * founder a share of every website enquiry because they happen to
         * hold an admin role.
         */
        expect(isAssignableRole(role)).toBe(false);
        expect(isEligibleForAssignment({ ...eligible, role })).toBe(false);
      },
    );

    it('is stated in exactly one place', () => {
      // If this list ever grows, it grows here — not in a controller, a
      // screen, or the assignment algorithm that has yet to be written.
      expect(ASSIGNABLE_ROLES).toEqual(['SALES_REP']);
    });
  });
});

describe('teamNameKey', () => {
  it('treats case and spacing as the same team', () => {
    // "Pune Sales" and "pune  sales " are one team to an administrator, so
    // they must be one team to the duplicate check.
    const spellings = ['Pune Sales', 'pune sales', '  PUNE   Sales  ', 'Pune\tSales'];

    expect(new Set(spellings.map(teamNameKey)).size).toBe(1);
  });

  it('keeps genuinely different names apart', () => {
    expect(teamNameKey('Pune Sales')).not.toBe(teamNameKey('Pune Exports'));
    // Punctuation is NOT stripped: nothing routes by team name, so flattening
    // it would only make two real teams collide.
    expect(teamNameKey('Key Accounts (North)')).not.toBe(teamNameKey('Key Accounts'));
  });
});
