import type { EmailExclusionReason } from '@leadflow/api-types';
import { normalizeEmailAddress, type MergeValues } from '../content/email-content';
import type { AudienceCandidate } from './audience.repository';

export interface AudienceMember {
  email: string;
  leadId: string | null;
  contactId: string | null;
  displayName: string | null;
  merge: MergeValues;
}

export interface AudienceResult {
  selected: number;
  eligible: AudienceMember[];
  excluded: Record<EmailExclusionReason, number>;
}

export interface EligibilityFacts {
  /** Addresses with a GRANTED marketing consent. */
  consented: Set<string>;
  /** Addresses on the suppression list, for any reason. */
  suppressed: Set<string>;
}

/**
 * Who of the matched people may actually receive this campaign, in a fixed
 * order of exclusion so the counts explain themselves:
 *
 *   INVALID     no usable address
 *   SUPPRESSED  unsubscribed, bounced, complained or manually suppressed —
 *               applies to EVERY campaign, promotional or not
 *   NO_CONSENT  promotional, and nobody has recorded why this address may get it
 *   DUPLICATE   the same address reached twice (a lead and its contact)
 *
 * Run when the audience is previewed, again when the campaign is confirmed,
 * and the suppression and consent checks once more right before each send.
 */
export function evaluateAudience(
  candidates: AudienceCandidate[],
  purpose: 'PROMOTIONAL' | 'TRANSACTIONAL',
  facts: EligibilityFacts,
  organizationName: string,
): AudienceResult {
  const excluded: Record<EmailExclusionReason, number> = {
    INVALID: 0,
    SUPPRESSED: 0,
    NO_CONSENT: 0,
    DUPLICATE: 0,
  };
  const seen = new Set<string>();
  const eligible: AudienceMember[] = [];

  for (const candidate of candidates) {
    const email = normalizeEmailAddress(candidate.email);
    if (!email) {
      excluded.INVALID++;
      continue;
    }
    if (facts.suppressed.has(email)) {
      excluded.SUPPRESSED++;
      continue;
    }
    if (purpose === 'PROMOTIONAL' && !facts.consented.has(email)) {
      excluded.NO_CONSENT++;
      continue;
    }
    if (seen.has(email)) {
      excluded.DUPLICATE++;
      continue;
    }
    seen.add(email);
    const fullName =
      [candidate.firstName, candidate.lastName].filter(Boolean).join(' ').trim() || null;
    eligible.push({
      email,
      leadId: candidate.leadId,
      contactId: candidate.contactId,
      displayName: fullName,
      merge: {
        first_name: candidate.firstName,
        last_name: candidate.lastName,
        full_name: fullName,
        company: candidate.company,
        city: candidate.city,
        organization: organizationName,
      },
    });
  }

  return { selected: candidates.length, eligible, excluded };
}
