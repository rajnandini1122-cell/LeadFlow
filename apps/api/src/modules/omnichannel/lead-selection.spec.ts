import { selectLead, type LeadCandidate } from './lead-selection';
import type { LeadStatus } from '@leadflow/api-types';

/**
 * The rules that decide which lead an incoming message belongs to.
 *
 * These assertions are the specification. Getting one wrong does not throw or
 * fail loudly — it files a customer's message under someone else's deal, where
 * it is read by the wrong rep and never answered by the right one.
 */

let sequence = 0;

function lead(overrides: Partial<LeadCandidate> = {}): LeadCandidate {
  sequence += 1;
  return {
    id: `lead-${sequence}`,
    leadNumber: `LD-${String(sequence).padStart(6, '0')}`,
    status: 'QUALIFIED' as LeadStatus,
    assignedToId: 'user-tony',
    companyName: 'XYZ Foods',
    createdAt: new Date('2026-08-01T10:00:00Z'),
    ...overrides,
  };
}

describe('selectLead', () => {
  describe('no lead to attach to', () => {
    it('returns NONE when the contact has no leads at all', () => {
      expect(selectLead([])).toEqual({ outcome: 'NONE' });
    });

    it.each<LeadStatus>(['WON', 'LOST'])(
      'returns NONE when the only lead is %s',
      (status) => {
        // A closed deal is finished. A new message about it is new business,
        // and attaching it here would reopen a lead the status machine
        // deliberately refuses to reopen.
        expect(selectLead([lead({ status })])).toEqual({ outcome: 'NONE' });
      },
    );

    it('ignores terminal leads even when several exist', () => {
      const candidates = [lead({ status: 'WON' }), lead({ status: 'LOST' })];
      expect(selectLead(candidates)).toEqual({ outcome: 'NONE' });
    });
  });

  describe('exactly one active lead', () => {
    it('matches it', () => {
      const only = lead();
      const selection = selectLead([only]);

      expect(selection).toEqual({ outcome: 'MATCHED', lead: only });
    });

    it('matches the single active lead alongside closed ones', () => {
      const active = lead({ status: 'NEGOTIATION' });
      const selection = selectLead([lead({ status: 'WON' }), active, lead({ status: 'LOST' })]);

      expect(selection).toEqual({ outcome: 'MATCHED', lead: active });
    });

    it.each<LeadStatus>([
      'NEW',
      'CONTACTED',
      'QUALIFIED',
      'FOLLOW_UP',
      'QUOTATION_SENT',
      'NEGOTIATION',
    ])('treats %s as active', (status) => {
      const selection = selectLead([lead({ status })]);
      expect(selection.outcome).toBe('MATCHED');
    });
  });

  describe('more than one active lead', () => {
    it('refuses to choose and asks for review', () => {
      const first = lead({ createdAt: new Date('2026-08-01T00:00:00Z') });
      const second = lead({ createdAt: new Date('2026-08-10T00:00:00Z') });

      const selection = selectLead([first, second]);

      // The whole point: one customer with two live enquiries is precisely
      // when the newest is NOT obviously the one they are writing about.
      expect(selection.outcome).toBe('AMBIGUOUS');
    });

    it('returns the candidates newest first, so review can lead with the likeliest', () => {
      const older = lead({ createdAt: new Date('2026-08-01T00:00:00Z') });
      const newer = lead({ createdAt: new Date('2026-08-10T00:00:00Z') });

      const selection = selectLead([older, newer]);

      if (selection.outcome !== 'AMBIGUOUS') throw new Error('expected AMBIGUOUS');
      expect(selection.candidates.map((candidate) => candidate.id)).toEqual([newer.id, older.id]);
    });

    it('excludes closed leads from the candidate list', () => {
      const won = lead({ status: 'WON' });
      const a = lead();
      const b = lead();

      const selection = selectLead([won, a, b]);

      if (selection.outcome !== 'AMBIGUOUS') throw new Error('expected AMBIGUOUS');
      expect(selection.candidates.map((candidate) => candidate.id)).not.toContain(won.id);
      expect(selection.candidates).toHaveLength(2);
    });
  });

  describe('a conversation that already belongs to a lead', () => {
    it('stays on that lead even when others are also active', () => {
      const linked = lead();
      const other = lead({ createdAt: new Date('2026-08-20T00:00:00Z') });

      const selection = selectLead([linked, other], linked.id);

      // Without this, a redelivered message would be re-evaluated against a
      // pipeline that has moved on and raise a review nobody asked for.
      expect(selection).toEqual({ outcome: 'MATCHED', lead: linked });
    });

    it('stays on that lead even after it has been won', () => {
      // Closing a deal must not detach the conversation that produced it.
      const linked = lead({ status: 'WON' });
      const selection = selectLead([linked], linked.id);

      expect(selection).toEqual({ outcome: 'MATCHED', lead: linked });
    });

    it('falls back to normal matching when the linked lead is gone', () => {
      // Archived or deleted, so it is not in the candidate list any more.
      const remaining = lead();
      const selection = selectLead([remaining], 'lead-that-no-longer-exists');

      expect(selection).toEqual({ outcome: 'MATCHED', lead: remaining });
    });

    it('does not resurrect a link to a lead outside the candidate list', () => {
      // The candidates are already tenant-scoped by the caller, so a lead id
      // from another organization simply is not among them. It must not be
      // honoured just because the conversation names it.
      const selection = selectLead([], 'lead-in-another-organization');

      expect(selection).toEqual({ outcome: 'NONE' });
    });
  });
});
