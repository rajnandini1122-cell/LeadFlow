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
  /** Would be eligible, but taken out by hand in the recipient list. */
  handExcluded: AudienceMember[];
  /**
   * Matched the filters but cannot receive it (yet): listed so a person can
   * still see them and take them out of the group by hand.
   */
  ineligible: { member: AudienceMember; reason: IneligibleReason; excludedByHand: boolean }[];
}

export type IneligibleReason = 'NO_CONSENT' | 'SUPPRESSED';

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
 *   EXCLUDED    would be eligible, but taken out by hand in the recipient list
 *
 * Run when the audience is previewed, again when the campaign is confirmed,
 * and the suppression and consent checks once more right before each send.
 */
export function evaluateAudience(
  candidates: AudienceCandidate[],
  purpose: 'PROMOTIONAL' | 'TRANSACTIONAL',
  facts: EligibilityFacts,
  organizationName: string,
  excludeEmails: ReadonlySet<string> = new Set(),
): AudienceResult {
  const excluded: Record<EmailExclusionReason, number> = {
    INVALID: 0,
    SUPPRESSED: 0,
    NO_CONSENT: 0,
    DUPLICATE: 0,
    EXCLUDED: 0,
  };
  const handExcluded: AudienceMember[] = [];
  const ineligible: AudienceResult['ineligible'] = [];
  const seen = new Set<string>();
  const seenIneligible = new Set<string>();
  const eligible: AudienceMember[] = [];

  for (const candidate of candidates) {
    const email = normalizeEmailAddress(candidate.email);
    if (!email) {
      excluded.INVALID++;
      continue;
    }
    const fullName =
      [candidate.firstName, candidate.lastName].filter(Boolean).join(' ').trim() || null;
    const member: AudienceMember = {
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
    };
    const notReceiving: IneligibleReason | null = facts.suppressed.has(email)
      ? 'SUPPRESSED'
      : purpose === 'PROMOTIONAL' && !facts.consented.has(email)
        ? 'NO_CONSENT'
        : null;
    if (notReceiving) {
      excluded[notReceiving]++;
      if (!seenIneligible.has(email)) {
        seenIneligible.add(email);
        ineligible.push({ member, reason: notReceiving, excludedByHand: excludeEmails.has(email) });
      }
      continue;
    }
    if (seen.has(email)) {
      excluded.DUPLICATE++;
      continue;
    }
    seen.add(email);
    (excludeEmails.has(email) ? handExcluded : eligible).push(member);
  }

  excluded.EXCLUDED = handExcluded.length;
  return { selected: candidates.length, eligible, excluded, handExcluded, ineligible };
}

export interface RecipientListing {
  recipients: {
    email: string;
    name: string | null;
    company: string | null;
    excluded: boolean;
    ineligible: IneligibleReason | null;
  }[];
  recipientsTruncated: boolean;
  recipientsListed: boolean;
  recipientsTotal: number;
  undisplayedEligible: number;
}

/**
 * The addresses the editor shows for ticking: eligible and hand-excluded
 * together, sorted by address, at most `limit`. Says exactly how many eligible
 * people fall outside the displayed list, because they still receive it.
 */
export function listRecipients(
  result: Pick<AudienceResult, 'eligible' | 'handExcluded'> &
    Partial<Pick<AudienceResult, 'ineligible'>>,
  mayList: boolean,
  limit: number,
): RecipientListing {
  const ineligible = result.ineligible ?? [];
  const total = result.eligible.length + result.handExcluded.length + ineligible.length;
  if (!mayList) {
    return {
      recipients: [],
      recipientsTruncated: false,
      recipientsListed: false,
      recipientsTotal: total,
      undisplayedEligible: result.eligible.length,
    };
  }
  const all = [
    ...result.eligible.map((m) => ({
      m,
      excluded: false,
      reason: null as IneligibleReason | null,
    })),
    ...result.handExcluded.map((m) => ({
      m,
      excluded: true,
      reason: null as IneligibleReason | null,
    })),
    ...ineligible.map((i) => ({ m: i.member, excluded: i.excludedByHand, reason: i.reason })),
  ].sort((a, b) => a.m.email.localeCompare(b.m.email));
  const shown = all.slice(0, limit);
  return {
    recipients: shown.map(({ m, excluded, reason }) => ({
      email: m.email,
      name: m.displayName,
      company: m.merge.company ?? null,
      excluded,
      ineligible: reason,
    })),
    recipientsTruncated: all.length > limit,
    recipientsListed: true,
    recipientsTotal: total,
    undisplayedEligible: all.slice(limit).filter((r) => !r.excluded && r.reason === null).length,
  };
}
