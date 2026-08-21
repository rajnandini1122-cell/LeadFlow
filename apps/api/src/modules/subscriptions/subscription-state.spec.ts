import {
  ACCESS_GRANTING_STATUSES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_TRANSITIONS,
  canTransition,
  grantsAccess,
  type SubscriptionStatus,
} from '@leadflow/api-types';

describe('canTransition', () => {
  it('lets a trial convert to a paying subscription', () => {
    expect(canTransition('TRIAL', 'ACTIVE')).toBe(true);
  });

  it('lets an active subscription fall into dunning', () => {
    expect(canTransition('ACTIVE', 'PAST_DUE')).toBe(true);
  });

  it('lets a past-due subscription recover', () => {
    expect(canTransition('PAST_DUE', 'ACTIVE')).toBe(true);
  });

  it('lets a returning customer reactivate', () => {
    expect(canTransition('CANCELLED', 'ACTIVE')).toBe(true);
    expect(canTransition('EXPIRED', 'ACTIVE')).toBe(true);
  });

  it('never allows a return to TRIAL', () => {
    // Otherwise an organization could cycle free periods indefinitely by
    // cancelling and restarting.
    for (const from of SUBSCRIPTION_STATUSES) {
      expect(canTransition(from, 'TRIAL')).toBe(false);
    }
  });

  it('does not let an active subscription expire without passing through dunning', () => {
    // Something must first observe a failed payment or an explicit
    // cancellation, so an account is never cut off with no recorded reason.
    expect(canTransition('ACTIVE', 'EXPIRED')).toBe(false);
  });

  it('refuses a no-op transition', () => {
    // Almost always a duplicate webhook or a double-clicked button. Treating
    // it as success hides that.
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('refuses reviving a cancelled subscription into dunning', () => {
    expect(canTransition('CANCELLED', 'PAST_DUE')).toBe(false);
    expect(canTransition('EXPIRED', 'PAST_DUE')).toBe(false);
    expect(canTransition('CANCELLED', 'EXPIRED')).toBe(false);
  });

  it('handles an unknown source status without throwing', () => {
    expect(canTransition('NONSENSE' as SubscriptionStatus, 'ACTIVE')).toBe(false);
  });

  it('every declared target is itself a real status', () => {
    // Guards against a typo in the transition table that would make a legal
    // move permanently impossible.
    for (const targets of Object.values(SUBSCRIPTION_TRANSITIONS)) {
      for (const target of targets) {
        expect(SUBSCRIPTION_STATUSES).toContain(target);
      }
    }
  });

  it('every status appears in the table', () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(SUBSCRIPTION_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('every status except TRIAL is reachable from somewhere', () => {
    const reachable = new Set(Object.values(SUBSCRIPTION_TRANSITIONS).flat());

    for (const status of SUBSCRIPTION_STATUSES) {
      if (status === 'TRIAL') continue;
      expect(reachable).toContain(status);
    }
  });
});

describe('grantsAccess', () => {
  it('keeps a past-due customer working', () => {
    // Locking someone out on the first failed charge — usually an expired
    // card — loses accounts a retry would have recovered.
    expect(grantsAccess('PAST_DUE')).toBe(true);
  });

  it('grants access during a trial and while active', () => {
    expect(grantsAccess('TRIAL')).toBe(true);
    expect(grantsAccess('ACTIVE')).toBe(true);
  });

  it('withdraws access only on a decision, not an accident', () => {
    expect(grantsAccess('CANCELLED')).toBe(false);
    expect(grantsAccess('EXPIRED')).toBe(false);
  });

  it('agrees with the exported list', () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(grantsAccess(status)).toBe(ACCESS_GRANTING_STATUSES.includes(status));
    }
  });
});
