import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, type AuthenticatedUser, type TokenPair } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { AuditRepository } from '../../common/audit/audit.repository';
import { DEFAULT_LEAD_SOURCES } from '../organizations/lead-sources';
import { isReserved, isValidSlug, resolveAvailableSlug, slugify } from '../organizations/slug';
import { RegistrationRepository } from './registration.repository';
import { PasswordService } from './password.service';
import { randomBytes } from 'node:crypto';
import { SessionService, type RequestMetadata } from './session.service';
import { GoogleAuthService } from './google-auth.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
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
    private readonly subscriptions: SubscriptionsService,
    private readonly google: GoogleAuthService,
  ) {}

  /**
   * Creates an organization for somebody arriving via Google.
   *
   * Reuses `register` entirely rather than duplicating the tenant-creation
   * path. That matters more than the saved lines: creating an organization
   * also seeds its settings, assigns the OWNER role and starts a trial, and a
   * second implementation would inevitably miss one of those and produce a
   * tenant that looks fine until something it never got is needed.
   *
   * The email and name come from the VERIFIED token, never from the request
   * body. Taking them from the body would let a caller present their own valid
   * Google token and register an organization under somebody else's address.
   *
   * The account gets a random password it is never told. Google is how this
   * person signs in; a known placeholder would be a shared credential across
   * every Google account on the deployment, and leaving it null would make
   * this row a special case for every other auth path.
   */
  async registerWithGoogle(
    input: { idToken: string; organizationName: string; platform?: string | undefined },
    meta: RequestMetadata,
  ): Promise<{ tokens: TokenPair; user: AuthenticatedUser; refreshToken: string }> {
    const identity = await this.google.verify(input.idToken);

    // Google gives one display name, not two fields. Split on the first space
    // so the common case is right, and never leave the surname empty.
    const parts = (identity.fullName ?? identity.email.split('@')[0] ?? 'New user')
      .trim()
      .split(/\s+/);
    const firstName = parts[0] ?? 'New';
    const lastName = parts.slice(1).join(' ') || firstName;

    return this.register(
      {
        organizationName: input.organizationName,
        firstName,
        lastName,
        email: identity.email,
        password: randomBytes(32).toString('base64url'),
        platform: input.platform,
        // From the verified token, never the request body.
        googleSubject: identity.subject,
      } as RegisterDto & { googleSubject: string },
      meta,
    );
  }

  async register(
    /*
     * `googleSubject` is deliberately NOT on RegisterDto.
     *
     * It is set only by registerWithGoogle, from a verified token. Putting it
     * on the public DTO would let a request body claim any Google identity and
     * mint an account that Google sign-in would then accept.
     */
    dto: RegisterDto & { googleSubject?: string },
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
        ...(dto.googleSubject ? { googleSubject: dto.googleSubject } : {}),
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

    // Starts the trial. Deliberately after the organization exists and outside
    // its transaction: never throws, because a tenant with no subscription row
    // is recoverable, whereas a registration that fails because the plan
    // catalogue was not seeded turns a would-be customer away entirely.
    await this.subscriptions.startTrial(created.organization.id);

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
