import { Injectable } from '@nestjs/common';
import type {
  OrganizationDetail,
  OrganizationSettings,
  OrganizationStatus,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { AUDIT_ACTIONS, AuditRepository } from '../../common/audit/audit.repository';
import { OrganizationsRepository } from './organizations.repository';
import type { UpdateOrganizationDto } from './dto/organizations.dto';

/** Mirrors the column defaults in schema.prisma. */
const DEFAULT_SETTINGS: OrganizationSettings = {
  followupReminderMinutes: 30,
  followupOverdueMinutes: 120,
  escalateToManager: false,
  workingHoursStart: '09:30',
  workingHoursEnd: '18:30',
  leadSources: [],
  omnichannelEnabled: false,
  sharedUnassignedQueue: false,
  whatsappAutoLeadEnabled: false,
};

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly repository: OrganizationsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async current(): Promise<OrganizationDetail> {
    const organization = await this.repository.findCurrent();
    if (!organization) throw AppException.organizationNotFound();
    return toDetail(organization);
  }

  async update(dto: UpdateOrganizationDto): Promise<OrganizationDetail> {
    const before = await this.repository.findCurrent();
    if (!before) throw AppException.organizationNotFound();

    const updated = await this.repository.updateCurrent(dto);
    if (!updated) throw AppException.organizationNotFound();

    // Currency, locale, country and timezone change how every existing figure
    // is read — money, dates, and how a phone number canonicalises. A record
    // of who changed them is what makes "these numbers look different" an
    // answerable question.
    await this.audit.record({
      action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
      entityType: 'organization',
      entityId: before.id,
      before: snapshot(before),
      after: snapshot(updated),
    });

    return toDetail(updated);
  }
}

/**
 * The tenant-visible configuration, for the audit trail.
 *
 * Includes SETTINGS as well as the organization's own columns. It previously
 * recorded only the columns, so a settings change produced an audit row whose
 * before and after were identical — the event was logged and the actual change
 * was not, which is the one thing an audit row exists to answer.
 *
 * That matters most for the settings that change what the product does on
 * somebody's behalf: `sharedUnassignedQueue` decides who sees a customer's
 * unclaimed message, and `whatsappAutoLeadEnabled` decides whether enquiries
 * are turned into assigned leads with no human in the loop. "Who opened the
 * unassigned queue to the whole team" and "who switched automatic lead creation
 * on, and when" both have to be answerable.
 *
 * Every settings field is listed explicitly rather than spread, so adding one
 * to the schema does not silently start appearing in audit rows — but the cost
 * is that a new field must be added here too. `whatsappAutoLeadEnabled` was
 * missed exactly that way when two branches merged, and compiled fine.
 */
function snapshot(organization: OrganizationRow): Record<string, unknown> {
  return {
    name: organization.name,
    timezone: organization.timezone,
    currency: organization.currency,
    locale: organization.locale,
    country: organization.country,
    settings: organization.settings
      ? {
          followupReminderMinutes: organization.settings.followupReminderMinutes,
          followupOverdueMinutes: organization.settings.followupOverdueMinutes,
          escalateToManager: organization.settings.escalateToManager,
          workingHoursStart: organization.settings.workingHoursStart,
          workingHoursEnd: organization.settings.workingHoursEnd,
          leadSources: organization.settings.leadSources,
          omnichannelEnabled: organization.settings.omnichannelEnabled,
          sharedUnassignedQueue: organization.settings.sharedUnassignedQueue,
          whatsappAutoLeadEnabled: organization.settings.whatsappAutoLeadEnabled,
        }
      : null,
  };
}

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  locale: string;
  country: string;
  status: string;
  createdAt: Date;
  settings: {
    followupReminderMinutes: number;
    followupOverdueMinutes: number;
    escalateToManager: boolean;
    workingHoursStart: string;
    workingHoursEnd: string;
    leadSources: string[];
    omnichannelEnabled: boolean;
    sharedUnassignedQueue: boolean;
    whatsappAutoLeadEnabled: boolean;
  } | null;
};

function toDetail(organization: OrganizationRow): OrganizationDetail {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    timezone: organization.timezone,
    currency: organization.currency,
    locale: organization.locale,
    country: organization.country,
    status: organization.status as OrganizationStatus,
    createdAt: organization.createdAt.toISOString(),
    settings: organization.settings
      ? {
          followupReminderMinutes: organization.settings.followupReminderMinutes,
          followupOverdueMinutes: organization.settings.followupOverdueMinutes,
          escalateToManager: organization.settings.escalateToManager,
          workingHoursStart: organization.settings.workingHoursStart,
          workingHoursEnd: organization.settings.workingHoursEnd,
          leadSources: organization.settings.leadSources,
          omnichannelEnabled: organization.settings.omnichannelEnabled,
          sharedUnassignedQueue: organization.settings.sharedUnassignedQueue,
          whatsappAutoLeadEnabled: organization.settings.whatsappAutoLeadEnabled,
        }
      : DEFAULT_SETTINGS,
  };
}
