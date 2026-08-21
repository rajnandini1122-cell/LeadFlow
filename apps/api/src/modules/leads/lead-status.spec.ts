import { ACTIVE_STATUSES, canTransition, isTerminal, sideEffectsFor } from './lead-status';

describe('canTransition', () => {
  describe('movement between active stages', () => {
    it('allows moving forward', () => {
      expect(canTransition('NEW', 'QUALIFIED').allowed).toBe(true);
      expect(canTransition('QUALIFIED', 'NEGOTIATION').allowed).toBe(true);
    });

    it('allows moving BACKWARD', () => {
      // Real selling is not a clean march forward. Forbidding this would leave
      // people unable to record what happened, and they stop updating the CRM.
      expect(canTransition('NEGOTIATION', 'CONTACTED').allowed).toBe(true);
      expect(canTransition('QUOTATION_SENT', 'QUALIFIED').allowed).toBe(true);
    });

    it('allows skipping stages', () => {
      expect(canTransition('NEW', 'NEGOTIATION').allowed).toBe(true);
    });

    it('allows a no-op', () => {
      expect(canTransition('QUALIFIED', 'QUALIFIED').allowed).toBe(true);
    });

    it.each(ACTIVE_STATUSES)('allows %s to be won or lost', (status) => {
      expect(canTransition(status, 'WON').allowed).toBe(true);
      expect(canTransition(status, 'LOST').allowed).toBe(true);
    });
  });

  describe('WON is final', () => {
    it.each([...ACTIVE_STATUSES, 'LOST' as const])(
      'refuses to move a won deal to %s',
      (target) => {
        const result = canTransition('WON', target);

        // Reopening a won deal would corrupt every conversion figure already
        // reported.
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(/cannot be reopened/i);
      },
    );

    it('allows WON to WON as a no-op', () => {
      expect(canTransition('WON', 'WON').allowed).toBe(true);
    });
  });

  describe('LOST is reversible, but not straight to WON', () => {
    it.each(ACTIVE_STATUSES)('allows a lost lead to reopen into %s', (target) => {
      // Customers do come back.
      expect(canTransition('LOST', target).allowed).toBe(true);
    });

    it('refuses LOST straight to WON', () => {
      const result = canTransition('LOST', 'WON');

      // Would produce a deal nobody worked, skipping the pipeline entirely.
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/active stage first/i);
    });
  });
});

describe('isTerminal', () => {
  it.each(['WON', 'LOST'] as const)('treats %s as terminal', (status) => {
    expect(isTerminal(status)).toBe(true);
  });

  it.each(ACTIVE_STATUSES)('treats %s as active', (status) => {
    expect(isTerminal(status)).toBe(false);
  });
});

describe('sideEffectsFor', () => {
  it('stamps wonAt and records the closed value', () => {
    const effects = sideEffectsFor('WON', { wonValue: 50000 });

    expect(effects.wonAt).toBeInstanceOf(Date);
    expect(effects.wonValue).toBe(50000);
    expect(effects.lostAt).toBeNull();
    // A terminal lead needs no next action — that is the CHECK constraint's
    // only exemption.
    expect(effects.requiresFollowUp).toBe(false);
  });

  it('clears a stale lost reason when a lost lead is won', () => {
    const effects = sideEffectsFor('WON', { lostReason: 'Too expensive', wonValue: 1000 });
    expect(effects.lostReason).toBeNull();
  });

  it('stamps lostAt and keeps the reason', () => {
    const effects = sideEffectsFor('LOST', { lostReason: 'Chose a competitor' });

    expect(effects.lostAt).toBeInstanceOf(Date);
    expect(effects.lostReason).toBe('Chose a competitor');
    expect(effects.wonAt).toBeNull();
    expect(effects.requiresFollowUp).toBe(false);
  });

  it('clears BOTH terminal markers when reopening to an active stage', () => {
    const effects = sideEffectsFor('CONTACTED', {});

    // Otherwise the record claims to be simultaneously open and closed.
    expect(effects.wonAt).toBeNull();
    expect(effects.lostAt).toBeNull();
    expect(effects.lostReason).toBeNull();
    expect(effects.wonValue).toBeNull();
  });

  it.each(ACTIVE_STATUSES)('requires a follow-up for active status %s', (status) => {
    // The "no lead left behind" rule, expressed where every caller sees it.
    expect(sideEffectsFor(status, {}).requiresFollowUp).toBe(true);
  });
});
