import { Injectable } from '@nestjs/common';
import type { EmailSuppressionView, MarketingEligibilityView } from '@leadflow/api-types';
import { AppException } from '../../../common/errors/app.exception';
import { AuditRepository } from '../../../common/audit/audit.repository';
import { auditAttribution, type MutationActor } from '../../../common/audit/mutation-actor';
import { normalizeEmailAddress } from '../content/email-content';
import { ConsentRepository, PERMANENT_SUPPRESSIONS } from './consent.repository';
import type { GrantConsentDto, SuppressDto, WithdrawConsentDto } from './dto/consent.dto';

export const CONSENT_AUDIT = {
  GRANTED: 'email.consent.granted',
  WITHDRAWN: 'email.consent.withdrawn',
  SUPPRESSED: 'email.suppression.added',
  UNSUPPRESSED: 'email.suppression.removed',
} as const;

/**
 * Marketing eligibility.
 *
 * Unknown is NOT eligible. An address becomes eligible for promotional mail
 * only when a person records why (consent, existing customer, or a reviewed
 * legitimate interest) — never by import, never by default.
 *
 * And an address that unsubscribed or complained cannot be made eligible
 * again from here, by anyone: only the person can opt back in.
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly repository: ConsentRepository,
    private readonly audit: AuditRepository,
  ) {}

  async eligibility(search: string | null): Promise<MarketingEligibilityView[]> {
    const term = search?.trim() || null;
    const [{ leads, contacts }, recorded] = await Promise.all([
      this.repository.knownAddresses(term, 2000),
      this.repository.recordedAddresses(term, 2000),
    ]);
    const byEmail = new Map<string, MarketingEligibilityView>();
    const add = (
      raw: string | null,
      name: string | null,
      company: string | null,
      source: MarketingEligibilityView['sources'][number],
    ) => {
      const email = normalizeEmailAddress(raw);
      if (!email) return;
      const existing = byEmail.get(email);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        existing.name ??= name;
        existing.company ??= company;
        return;
      }
      byEmail.set(email, {
        email,
        name,
        company,
        sources: [source],
        status: 'UNKNOWN',
        basis: null,
        source: null,
        note: null,
        recordedAt: null,
        suppressed: null,
      });
    };
    for (const lead of leads)
      add(lead.email, fullName(lead.firstName, lead.lastName), lead.companyName, 'LEAD');
    for (const contact of contacts)
      add(
        contact.email,
        fullName(contact.firstName, contact.lastName),
        contact.companyName,
        'CONTACT',
      );
    // Added by hand: listed only when no lead or contact already shows it.
    for (const email of recorded) if (!byEmail.has(email)) add(email, null, null, 'MANUAL');

    const emails = [...byEmail.keys()];
    const [consents, suppressions] = await Promise.all([
      this.repository.consentsFor(emails),
      this.repository.suppressionsFor(emails),
    ]);
    for (const view of byEmail.values()) {
      const consent = consents.get(view.email);
      if (consent) {
        view.status = consent.status;
        view.basis = consent.basis;
        view.source = consent.source;
        view.note = consent.note;
        view.recordedAt = consent.recordedAt.toISOString();
      }
      view.suppressed = suppressions.get(view.email)?.reason ?? null;
    }
    return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
  }

  async grant(
    dto: GrantConsentDto,
    actor: MutationActor,
  ): Promise<{ granted: string[]; refused: { email: string; reason: string }[] }> {
    const emails = this.normalizeAll(dto.emails);
    const suppressions = await this.repository.suppressionsFor(emails);
    const refused: { email: string; reason: string }[] = [];
    const granted: string[] = [];
    for (const email of emails) {
      const suppression = suppressions.get(email);
      if (suppression && PERMANENT_SUPPRESSIONS.includes(suppression.reason)) {
        refused.push({
          email,
          reason: suppression.reason === 'UNSUBSCRIBED' ? 'unsubscribed' : 'complained',
        });
      } else {
        granted.push(email);
      }
    }
    if (granted.length > 0) {
      await this.repository.grant(granted, {
        basis: dto.basis,
        source: 'manual',
        note: dto.note,
        by: actor.kind === 'USER' ? actor.userId : null,
      });
      await this.audit.record({
        action: CONSENT_AUDIT.GRANTED,
        entityType: 'MarketingConsent',
        ...auditAttribution(actor),
        after: {
          count: granted.length,
          basis: dto.basis,
          note: dto.note,
          emails: granted.slice(0, 200),
        },
      });
    }
    return { granted, refused };
  }

  async withdraw(dto: WithdrawConsentDto, actor: MutationActor): Promise<{ withdrawn: number }> {
    const emails = this.normalizeAll(dto.emails);
    await this.repository.withdraw(emails, {
      source: 'manual',
      note: dto.note ?? null,
      by: actor.kind === 'USER' ? actor.userId : null,
    });
    await this.audit.record({
      action: CONSENT_AUDIT.WITHDRAWN,
      entityType: 'MarketingConsent',
      ...auditAttribution(actor),
      after: { count: emails.length, note: dto.note ?? null, emails: emails.slice(0, 200) },
    });
    return { withdrawn: emails.length };
  }

  async suppressions(): Promise<EmailSuppressionView[]> {
    const rows = await this.repository.listSuppressions(5000);
    return rows.map((row) => ({
      email: row.email,
      reason: row.reason,
      source: row.source,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async suppress(dto: SuppressDto, actor: MutationActor): Promise<{ suppressed: number }> {
    const emails = this.normalizeAll(dto.emails);
    for (const email of emails) {
      await this.repository.suppress(email, {
        reason: 'MANUAL',
        source: 'manual',
        note: dto.note,
        by: actor.kind === 'USER' ? actor.userId : null,
      });
    }
    await this.audit.record({
      action: CONSENT_AUDIT.SUPPRESSED,
      entityType: 'EmailSuppression',
      ...auditAttribution(actor),
      after: {
        count: emails.length,
        reason: 'MANUAL',
        note: dto.note,
        emails: emails.slice(0, 200),
      },
    });
    return { suppressed: emails.length };
  }

  async unsuppress(rawEmail: string, note: string, actor: MutationActor): Promise<void> {
    const email = normalizeEmailAddress(rawEmail);
    if (!email) throw AppException.validation('Enter a valid email address.');
    const existing = (await this.repository.suppressionsFor([email])).get(email);
    if (!existing) return;
    if (PERMANENT_SUPPRESSIONS.includes(existing.reason)) {
      throw AppException.validation(
        'This address unsubscribed or reported spam. Only the person can opt back in; it cannot be removed here.',
      );
    }
    await this.repository.removeSuppression(email);
    await this.audit.record({
      action: CONSENT_AUDIT.UNSUPPRESSED,
      entityType: 'EmailSuppression',
      entityId: existing.id,
      ...auditAttribution(actor),
      before: { email, reason: existing.reason },
      after: { note },
    });
  }

  private normalizeAll(raw: string[]): string[] {
    const emails = [...new Set(raw.map((value) => normalizeEmailAddress(value)))];
    if (emails.some((email) => email === null)) {
      throw AppException.validation('One or more email addresses are not valid.');
    }
    return emails as string[];
  }
}

export function fullName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : null;
}
