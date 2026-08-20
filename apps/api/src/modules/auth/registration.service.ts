import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, type AuthenticatedUser, type TokenPair } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import { DEFAULT_LEAD_SOURCES } from '../organizations/lead-sources';
import { isReserved, isValidSlug, resolveAvailableSlug, slugify } from '../organizations/slug';
import { RegistrationRepository } from './registration.repository';
import { PasswordService } from './password.service';
import { SessionService, type RequestMetadata } from './session.service';
import type { RegisterDto } from './dto/register.dto';

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    private readonly repository: RegistrationRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditRepository,
    private readonly config: AppConfig,
  ) {}

  async register(
    dto: RegisterDto,
    meta: RequestMetadata,
  ): Promise<{ tokens: TokenPair; user: AuthenticatedUser; refreshToken: string }> {
    if (await this.repository.emailExists(dto.email)) {
      // Deliberately explicit. Registration is not a login form, so there is no
      // enumeration advantage in hiding it, and "email already registered" is
      // the only message that tells the user what to actually do next.
      throw AppException.conflict(
        ERROR_CODES.USER_ALREADY_EXISTS,
        'An account with this email already exists. Sign in instead, or ask an ' +
          'administrator to invite you to their organization.',
      );
    }

    const slug = await this.resolveSlug(dto);

    const ownerRoleId = await this.repository.ownerRoleId();
    if (!ownerRoleId) {
      // The system roles are seeded by migration; their absence is an
      // operational fault, not something the caller can fix.
      this.logger.error('OWNER role missing — has the seed been run?');
      throw AppException.internal();
    }

    const passwordHash = await this.passwords.hash(dto.password);

    let created: Awaited<ReturnType<RegistrationRepository['createOrganizationWithOwner']>>;
    try {
      created = await this.repository.createOrganizationWithOwner({
        organizationName: dto.organizationName,
        slug,
        timezone: dto.timezone ?? this.config.get('DEFAULT_TIMEZONE'),
        currency: (dto.currency ?? this.config.get('DEFAULT_CURRENCY')).toUpperCase(),
        locale: this.config.get('DEFAULT_LOCALE'),
        country: (dto.country ?? this.config.get('DEFAULT_COUNTRY')).toUpperCase(),
        email: dto.email,
        passwordHash,
        fullName: `${dto.firstName} ${dto.lastName}`.trim(),
        ownerRoleId,
        leadSources: DEFAULT_LEAD_SOURCES,
      });
    } catch (error) {
      // Two registrations can agree on the same free slug or email between the
      // availability check and the insert. The unique constraints decide, and
      // the whole transaction rolls back — no half-created tenant survives.
      if ((error as { code?: string }).code === 'P2002') {
        throw AppException.conflict(
          ERROR_CODES.CONFLICT,
          'That organization or email was just registered. Please try again.',
        );
      }
      throw error;
    }

    const session = await this.sessions.issue({
      organizationId: created.organization.id,
      userId: created.user.id,
      role: 'OWNER',
      platform: dto.platform ?? 'WEB',
      meta,
    });

    await this.audit.record({
      action: 'organization.registered',
      organizationId: created.organization.id,
      actorUserId: created.user.id,
      entityType: 'organization',
      entityId: created.organization.id,
      after: { name: dto.organizationName, slug },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      tokens: session.tokens,
      refreshToken: session.refreshToken,
      user: {
        id: created.user.id,
        email: created.user.email,
        fullName: created.user.fullName,
        mobile: created.user.mobile,
        avatarUrl: created.user.avatarUrl,
        organization: {
          id: created.organization.id,
          name: created.organization.name,
          slug: created.organization.slug,
          timezone: created.organization.timezone,
          currency: created.organization.currency,
          locale: created.organization.locale,
          country: created.organization.country,
          status: created.organization.status,
        },
        role: 'OWNER',
        permissions: session.permissions,
      },
    };
  }

  /**
   * An explicit slug is honoured if it is free; otherwise one is derived from
   * the organization name and de-duplicated.
   */
  private async resolveSlug(dto: RegisterDto): Promise<string> {
    if (dto.organizationSlug) {
      if (!isValidSlug(dto.organizationSlug)) {
        throw AppException.validation('Invalid organization address.', {
          organizationSlug: ['may contain only lowercase letters, numbers and single hyphens'],
        });
      }
      if (isReserved(dto.organizationSlug)) {
        throw AppException.validation('That organization address is reserved.', {
          organizationSlug: ['please choose a different address'],
        });
      }
      if (await this.repository.isSlugTaken(dto.organizationSlug)) {
        throw AppException.validation('That organization address is already taken.', {
          organizationSlug: ['please choose a different address'],
        });
      }
      return dto.organizationSlug;
    }

    if (!slugify(dto.organizationName)) {
      throw AppException.validation('Organization name must contain letters or numbers.', {
        organizationName: ['cannot be only punctuation'],
      });
    }

    return resolveAvailableSlug(dto.organizationName, (slug) => this.repository.isSlugTaken(slug));
  }
}
