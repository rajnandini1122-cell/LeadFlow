import { LEAD_STATUSES, type LeadStatus } from '@leadflow/api-types';

/**
 * Status transition rules for the fixed pipeline (spec §8).
 *
 * The design question is how strict to be. Real selling is not a clean march
 * forward — a qualified lead goes quiet and drops back, a quotation is
 * withdrawn and re-sent. Forbidding backward moves would leave people unable to
 * record what actually happened, and the usual result is that they stop
 * updating the CRM at all.
 *
 * So movement between ACTIVE stages is unrestricted in either direction. The
 * rules that ARE enforced are the ones with consequences:
 *
 *   * WON is final. A closed-won deal is revenue; reopening it would corrupt
 *     every conversion figure that has already been reported.
 *   * LOST is reversible, because customers genuinely come back, but only to an
 *     active stage — never directly to WON, which would skip the pipeline and
 *     produce a deal nobody worked.
 *   * LOST requires a reason. Without it, "why do we lose?" is unanswerable,
 *     and that is the most valuable question in the dataset.
 */

const ORDER = new Map(LEAD_STATUSES.map((status, index) => [status, index]));

export const ACTIVE_STATUSES = LEAD_STATUSES.filter(
  (status) => status !== 'WON' && status !== 'LOST',
);

export function isTerminal(status: LeadStatus): boolean {
  return status === 'WON' || status === 'LOST';
}

export interface TransitionCheck {
  allowed: boolean;
  /** User-facing explanation. Present only when `allowed` is false. */
  reason?: string;
}

export function canTransition(from: LeadStatus, to: LeadStatus): TransitionCheck {
  if (from === to) return { allowed: true };

  if (from === 'WON') {
    return {
      allowed: false,
      reason:
        'A won deal cannot be reopened. Create a new lead for further business ' +
        'with this customer.',
    };
  }

  if (from === 'LOST' && to === 'WON') {
    return {
      allowed: false,
      reason:
        'Reopen this lead into an active stage first, so the work to win it ' +
        'back is recorded.',
    };
  }

  if (!ORDER.has(to)) {
    return { allowed: false, reason: `Unknown status: ${to}` };
  }

  return { allowed: true };
}

export interface StatusSideEffects {
  wonAt: Date | null;
  lostAt: Date | null;
  lostReason: string | null;
  /** Null clears any existing value; undefined leaves it untouched. */
  wonValue?: number | null;
  /** True when the caller must supply a next follow-up for this status. */
  requiresFollowUp: boolean;
}

/**
 * The timestamps and fields a status change implies.
 *
 * Centralised so that every path — direct edit, follow-up completion, future
 * bulk actions — writes the same fields. Scattering `wonAt = new Date()` across
 * call sites is how a lead ends up WON with no won date.
 */
export function sideEffectsFor(
  to: LeadStatus,
  input: { lostReason?: string | undefined; wonValue?: number | undefined },
): StatusSideEffects {
  if (to === 'WON') {
    return {
      wonAt: new Date(),
      lostAt: null,
      // Reopening from LOST must not leave a stale reason attached.
      lostReason: null,
      wonValue: input.wonValue ?? null,
      requiresFollowUp: false,
    };
  }

  if (to === 'LOST') {
    return {
      wonAt: null,
      lostAt: new Date(),
      lostReason: input.lostReason ?? null,
      wonValue: null,
      requiresFollowUp: false,
    };
  }

  // Back to an active stage: clear both terminal markers so the record does not
  // claim to be simultaneously open and closed.
  return {
    wonAt: null,
    lostAt: null,
    lostReason: null,
    wonValue: null,
    requiresFollowUp: true,
  };
}
