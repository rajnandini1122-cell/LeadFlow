import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { CredentialThrottle } from '../../common/throttler/credential-throttle.decorator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthenticatedUser, LoginResponse, TokenPair } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { AuthService, type RequestMetadata } from './auth.service';
import { GoogleRegisterDto, GoogleSignInDto, LoginDto, RefreshDto } from './dto/auth.dto';
import { RegisterDto } from './dto/register.dto';
import { SwitchOrganizationDto } from './dto/switch-organization.dto';
import { ResendVerificationDto, VerifyEmailDto } from './dto/email-verification.dto';
import { EmailVerificationService } from './email-verification.service';
import { RegistrationService } from './registration.service';
import { PasswordResetService } from './password-reset.service';
import { GoogleAuthService } from './google-auth.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/password.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser, TokenClaims } from './decorators/current-user.decorator';
import type { AccessTokenClaims } from './token.service';

const REFRESH_COOKIE = 'leadflow_rt';

/**
 * Credential endpoints carry @CredentialThrottle(): the strict limiter reaches
 * them and nothing else. Its numbers come from AUTH_THROTTLE_LIMIT /
 * AUTH_THROTTLE_TTL so a deployment can tune them.
 *
 * The rest of this controller — refresh, logout, the session list, `me` — is
 * ordinary authenticated traffic and is governed by the general API limit.
 * Refresh in particular must NOT sit in the credential bucket: several tabs,
 * a shared office IP and rotation every fifteen minutes make a handful of
 * attempts per quarter hour an outage rather than a protection.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly registration: RegistrationService,
    private readonly verification: EmailVerificationService,
    private readonly passwordReset: PasswordResetService,
    private readonly config: AppConfig,
    private readonly google: GoogleAuthService,
  ) {}

  @Public()
  @CredentialThrottle()
  @Post('register')
  @ApiOperation({
    summary: 'Register a new organization and its first owner',
    description:
      'Creates organization, settings, user and OWNER membership in a single ' +
      'transaction. A partial result would strand an organization nobody can ' +
      'sign in to.',
  })
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.registration.register(dto, metadataFrom(request));

    /*
     * An unverified account gets NO tokens and NO refresh cookie.
     *
     * Local registration always lands here. The client is told the account
     * exists and whether the verification email was accepted by the provider —
     * never that it was delivered, which nobody can know — and shows "check
     * your email" rather than a dashboard.
     */
    if (!result.verified) {
      return { verified: false, verificationEmailSent: result.verificationEmailSent, user: result.user };
    }

    // Reached only when an identity provider already proved the mailbox.
    if ((dto.platform ?? 'WEB') === 'WEB') {
      this.setRefreshCookie(response, result.refreshToken);
      return { verified: true, tokens: result.tokens, user: result.user };
    }

    return {
      verified: true,
      tokens: { ...result.tokens, refreshToken: result.refreshToken },
      user: result.user,
    };
  }

  @Get('organizations')
  @ApiOperation({ summary: 'Organizations the signed-in user may act in' })
  async organizations(@CurrentUser() principal: TenantPrincipal) {
    return this.auth.listOrganizations(principal);
  }

  @Post('switch-organization')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Switch to another organization without re-entering credentials',
    description:
      'The supplied organization id is validated against live membership, so ' +
      'it can only select among organizations the caller already belongs to.',
  })
  async switchOrganization(
    @Body() dto: SwitchOrganizationDto,
    @CurrentUser() principal: TenantPrincipal,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.switchOrganization(
      principal,
      dto.targetOrganizationId,
      dto.platform ?? 'WEB',
      metadataFrom(request),
    );

    if ((dto.platform ?? 'WEB') === 'WEB') {
      this.setRefreshCookie(response, result.refreshToken);
      return { tokens: result.tokens, user: result.user };
    }

    return {
      tokens: { ...result.tokens, refreshToken: result.refreshToken },
      user: result.user,
    };
  }

  @Public()
  @CredentialThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in and receive an access/refresh token pair' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const result = await this.auth.login(dto, metadataFrom(request));

    if (result.refreshToken) {
      this.attachRefreshToken(response, result.refreshToken, dto.platform ?? 'WEB', result.response);
    }

    return result.response;
  }

  /**
   * Whether Google sign-in is available here.
   *
   * Public and unauthenticated, because the login page needs it before anybody
   * has signed in. It exposes one boolean and the CLIENT ID — which is public
   * by design, embedded in every browser that renders the button. There is no
   * client secret in this flow at all.
   *
   * The button is hidden when this says false. A Google button that fails on
   * click reads as a broken product rather than an unconfigured one.
   */
  @Public()
  @Get('providers')
  @ApiOperation({ summary: 'Which sign-in methods this deployment offers' })
  providers(): { google: { enabled: boolean; clientId: string | null } } {
    return {
      google: {
        enabled: this.google.enabled,
        clientId: this.config.get('GOOGLE_CLIENT_ID') ?? null,
      },
    };
  }

  /**
   * Sign in with a Google account.
   *
   * Same throttle as the password login: this is a credential-presenting
   * endpoint, and leaving it unthrottled would make it the cheap way to probe
   * for accounts once the password route was rate limited.
   */
  @Public()
  @CredentialThrottle()
  @Post('google')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with Google' })
  async google_signIn(
    @Body() dto: GoogleSignInDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const result = await this.auth.loginWithGoogle(
      dto.idToken,
      { organizationId: dto.targetOrganizationId, platform: dto.platform },
      metadataFrom(request),
    );

    if (result.refreshToken) {
      this.attachRefreshToken(response, result.refreshToken, dto.platform ?? 'WEB', result.response);
    }

    return result.response;
  }

  /**
   * Create an organization for a Google account that has none.
   *
   * A separate call because it needs one thing Google cannot supply: the
   * organization's name. Inventing one from the email domain would create a
   * tenant nobody chose, named after a mail provider as often as a company.
   */
  @Public()
  @CredentialThrottle()
  @Post('google/register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an organization using a Google account' })
  async googleRegister(
    @Body() dto: GoogleRegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.registration.registerWithGoogle(
      {
        idToken: dto.idToken,
        organizationName: dto.organizationName,
        platform: dto.platform,
        // Tenant identity, exactly as the password path accepts it. Omitted
        // values fall through to the configured deployment defaults.
        timezone: dto.timezone,
        currency: dto.currency,
        locale: dto.locale,
        country: dto.country,
      },
      metadataFrom(request),
    );

    /*
     * Google registration DOES sign in, and the narrow reason is the
     * `email_verified` claim on a token Google signed: the provider has
     * already delivered a challenge to that mailbox and had it returned.
     * Emailing our own link would be asking the same question twice.
     *
     * If that claim is ever absent or false, GoogleAuthService refuses the
     * identity outright, so this branch cannot be reached by an unverified
     * external account.
     */
    if (!result.verified) {
      // Defensive: registerWithGoogle always passes the provider-proven flag,
      // so this is unreachable today. It exists because the alternative to an
      // explicit refusal here would be reading `tokens` off a union member
      // that does not have them.
      throw AppException.internal();
    }

    const payload = { requiresOrganizationSelection: false as const, tokens: result.tokens, user: result.user };
    this.attachRefreshToken(response, result.refreshToken, dto.platform ?? 'WEB', payload);

    return payload;
  }

  /**
   * Redeems a verification link.
   *
   * PUBLIC, because the person clicking it has no session by definition — an
   * unverified account cannot sign in, which is the whole point.
   *
   * Throttled with the credential limiter: the token is 32 random bytes, so
   * guessing is not a realistic attack, but an unauthenticated endpoint that
   * hits the database on every call should not be free.
   */
  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @CredentialThrottle()
  @ApiOperation({
    summary: 'Confirm an email address',
    description:
      'Single-use and time-limited. Answers with a stable code — INVALID, ' +
      'EXPIRED or ALREADY_COMPLETED — so the client can route to the right ' +
      'screen rather than matching on prose.',
  })
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() request: Request) {
    return this.verification.verify(dto.token, metadataFrom(request));
  }

  /**
   * Sends another verification link.
   *
   * PUBLIC and ENUMERATION-SAFE: the response is identical whether the address
   * has an unverified account, a verified one, or none at all. An
   * unauthenticated endpoint that distinguished them would tell a competitor
   * exactly who uses this product.
   *
   * Rate-limited twice over — this route's own throttle bounds one caller, and
   * a per-account budget in the service bounds how much mail any single
   * mailbox can be made to receive.
   */
  @Public()
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.OK)
  @CredentialThrottle()
  @ApiOperation({
    summary: 'Send a new verification link',
    description:
      'Always answers the same way, whatever the address. Rotates the token, ' +
      'so any previous link stops working.',
  })
  async resendVerification(@Body() dto: ResendVerificationDto, @Req() request: Request) {
    return this.verification.resend(dto.email, metadataFrom(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a refresh token; detects and punishes reuse' })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ tokens: TokenPair; user: AuthenticatedUser }> {
    // Web sends the httpOnly cookie; Android sends the body field.
    const token = readRefreshCookie(request) ?? dto.refreshToken;
    if (!token) throw AppException.tokenInvalid();

    const result = await this.auth.refresh(token, metadataFrom(request));

    const isCookieClient = readRefreshCookie(request) !== undefined;
    if (isCookieClient) {
      this.setRefreshCookie(response, result.refreshToken);
      return { tokens: result.tokens, user: result.user };
    }

    return {
      tokens: { ...result.tokens, refreshToken: result.refreshToken },
      user: result.user,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current session and deny-list its access token' })
  async logout(
    @CurrentUser() principal: TenantPrincipal,
    @TokenClaims() claims: AccessTokenClaims,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(principal, claims.jti, metadataFrom(request));
    response.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  // --- password reset -------------------------------------------------------

  @Public()
  @CredentialThrottle()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a password reset link',
    description:
      'Always responds identically whether or not the email has an account. ' +
      'Any difference would make this an unauthenticated way to enumerate ' +
      'customers.',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() request: Request) {
    return this.passwordReset.requestReset(dto.email, metadataFrom(request));
  }

  @Public()
  @CredentialThrottle()
  @Post('reset-password/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password using a reset token',
    description:
      'Single-use. Revokes every existing session, because a reset is usually ' +
      'a response to compromise. Deliberately does not sign the user in.',
  })
  async resetPassword(
    @Param('token') token: string,
    @Body() dto: ResetPasswordDto,
    @Req() request: Request,
  ) {
    await this.passwordReset.reset(token, dto.password, metadataFrom(request));
    return { reset: true };
  }

  @CredentialThrottle()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Requires the current password. Revokes other sessions but keeps the ' +
      'current one, so routine hygiene does not sign you out of the device ' +
      'you are using.',
  })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() principal: TenantPrincipal,
    @Req() request: Request,
  ) {
    await this.passwordReset.changePassword({
      userId: principal.userId,
      sessionId: principal.sessionId,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      meta: metadataFrom(request),
    });
    return { changed: true };
  }

  // --- session management ---------------------------------------------------

  @Get('sessions')
  @ApiOperation({ summary: 'Devices where you are currently signed in' })
  async sessions(@CurrentUser() principal: TenantPrincipal) {
    return this.passwordReset.listSessions(principal.userId, principal.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out one of your own sessions' })
  async revokeSession(
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @CurrentUser() principal: TenantPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.passwordReset.revokeSession(principal.userId, id, metadataFrom(request));
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user, their organization, role and permissions' })
  async me(@CurrentUser() principal: TenantPrincipal): Promise<AuthenticatedUser> {
    return this.auth.currentUser(principal);
  }

  // ---------------------------------------------------------------------------

  /**
   * Web gets the refresh token as an httpOnly cookie so that XSS cannot read
   * it. Android has no cookie jar and no XSS surface, so it receives the token
   * in the body and stores it in EncryptedSharedPreferences.
   */
  private attachRefreshToken(
    response: Response,
    refreshToken: string,
    platform: 'WEB' | 'ANDROID' | 'IOS',
    payload: LoginResponse,
  ): void {
    if (platform === 'WEB') {
      this.setRefreshCookie(response, refreshToken);
      return;
    }

    if (!payload.requiresOrganizationSelection) {
      payload.tokens.refreshToken = refreshToken;
    }
  }

  private setRefreshCookie(response: Response, refreshToken: string): void {
    response.cookie(REFRESH_COOKIE, refreshToken, this.cookieOptions());
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'strict' as const,
      // Scoped to the refresh endpoint so the token is not attached to every
      // request, which shrinks the surface for CSRF and accidental logging.
      path: '/api/v1/auth',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    };
  }
}

function metadataFrom(request: Request): RequestMetadata {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
  };
}

function readRefreshCookie(request: Request): string | undefined {
  const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
  return cookies?.[REFRESH_COOKIE];
}
