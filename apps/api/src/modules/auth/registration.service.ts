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
import { EmailVerificationService } from './email-verification.service';
import { GoogleAuthService } from './google-auth.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { RegisterDto } from './dto/register.dto';

/**
 * What registration produced.
 *
 * A UNION rather than optional fields, so a caller cannot read `tokens` without
 * first establishing that a session exists. The compiler enforces the branch
 * that decides whether somebody is signed in — which is exactly the decision
 * that used to be made implicitly, and wrongly.
 */
export type RegistrationResult =
  | { verified: false; verificationEmailSent: boolean; user: AuthenticatedUser }
  | { verified: true; tokens: TokenPair; refreshToken: string; user: AuthenticatedUser };

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
    private readonly verification: EmailVerificationService,
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
    input: {
      idToken: string;
      organizationName: string;
      platform?: string | undefined;
      timezone?: string | undefined;
      currency?: string | undefined;
      locale?: string | undefined;
      country?: string | undefined;
    },
    meta: RequestMetadata,
  ): Promise<RegistrationResult> {
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
        // Tenant identity travels the same road as the password path, so both
        // reach the one place that resolves configured defaults.
        timezone: input.timezone,
        currency: input.currency,
        locale: input.locale,
        country: input.country,
        // From the verified token, never the request body.
        googleSubject: identity.subject,
      } as RegisterDto & { googleSubject: string },
      meta,
      /*
       * Google already proved the mailbox.
       *
       * `GoogleAuthService.verify` refuses an identity whose `email_verified`
       * claim is absent or false, so reaching this line means the provider
       * delivered a challenge to that address and had it returned. Sending our
       * own link would ask the same question a second time.
       *
       * This is the ONLY caller that passes the flag, and it is an argument on
       * an internal method — no request body can set it.
       */
      { mailboxProvenByProvider: true },
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
    /**
     * Set ONLY by registerWithGoogle, from a token Google itself signed.
     *
     * An identity provider that asserts `email_verified` has already done what
     * our verification link does — it delivered a challenge to that mailbox
     * and got it back. Repeating the exercise would mean emailing a link to an
     * address Google just confirmed, which is friction with no security value.
     *
     * Never reachable from a request body: it is an argument on an internal
     * method, and the public DTO has no such field. A client that could set it
     * could mint a verified account for any address.
     */
    options: { mailboxProvenByProvider?: boolean } = {},
  ): Promise<RegistrationResult> {
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
        /*
         * What the registering owner said, else what this deployment is
         * configured for.
         *
         * Never the schema's column defaults. Those say US/UTC/USD/en-US
         * because that is what the first migration happened to write, and a
         * tenant created for an India-first product must not depend on which
         * of two unrelated files was more recently edited. The application
         * decides, from configuration, in one place.
         *
         * Every value here has already been validated by the DTO, and the
         * configured fallbacks are validated at boot.
         */
        timezone: dto.timezone ?? this.config.get('DEFAULT_TIMEZONE'),
        currency: dto.currency ?? this.config.get('DEFAULT_CURRENCY'),
        locale: dto.locale ?? this.config.get('DEFAULT_LOCALE'),
        country: dto.country ?? this.config.get('DEFAULT_COUNTRY'),
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

    /*
     * NO SESSION. This is the security change.
     *
     * Registration used to issue access and refresh tokens here and sign the
     * person straight into the dashboard, which meant a typo'd address
     * produced a working account whose owner could never recover it — password
     * reset goes to an address they do not control — and nothing stopped
     * anybody registering under somebody else's address.
     *
     * The account exists and the organization exists; what does not exist yet
     * is a session. It is created on the first successful sign-in, which
     * requires a verified mailbox.
     */
    /*
     * Two outcomes, and which one applies is decided here rather than by the
     * caller, so there is exactly one place that can grant a session.
     */
    let session: Awaited<ReturnType<SessionService['issue']>> | undefined;
    let verificationEmailSent = false;

    if (options.mailboxProvenByProvider) {
      await this.verification.markVerified(created.user.id, 'oidc');

      session = await this.sessions.issue({
        organizationId: created.organization.id,
        userId: created.user.id,
        role: 'OWNER',
        platform: dto.platform ?? 'WEB',
        meta,
      });
    } else {
      const verification = await this.verification.sendVerification(
        { id: created.user.id, email: created.user.email, fullName: created.user.fullName },
        meta,
      );

      verificationEmailSent = verification.accepted;
    }

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

    const user = {
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
      role: 'OWNER' as const,
      /*
       * An unverified account holds no session, so there are no permissions to
       * report. Empty rather than absent: the shape stays stable, and a client
       * that forgot to branch renders a user who can do nothing rather than
       * one who appears to be an owner.
       */
      permissions: session?.permissions ?? [],
    };

    if (session) {
      return { verified: true, tokens: session.tokens, refreshToken: session.refreshToken, user };
    }

    /*
     * No tokens. The account exists, the organization exists, and neither is
     * reachable until somebody proves they own the mailbox.
     */
    return { verified: false, verificationEmailSent, user };
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
