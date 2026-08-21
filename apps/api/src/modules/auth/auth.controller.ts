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
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthenticatedUser, LoginResponse, TokenPair } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { AuthService, type RequestMetadata } from './auth.service';
import { LoginDto, RefreshDto } from './dto/auth.dto';
import { RegisterDto } from './dto/register.dto';
import { SwitchOrganizationDto } from './dto/switch-organization.dto';
import { RegistrationService } from './registration.service';
import { PasswordResetService } from './password-reset.service';
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
 * Credential endpoints are governed by the strict `auth` throttler rather than
 * the general one — brute-force protection per spec §19.
 *
 * Skipping `default` leaves the named `auth` limiter as the only one in force.
 * Its limits come from AUTH_THROTTLE_LIMIT / AUTH_THROTTLE_TTL, so they can be
 * tuned per environment; hardcoding them in a decorator here would make them
 * unconfigurable and would silently override the deployment's own settings.
 */
@ApiTags('auth')
@SkipThrottle({ default: true })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly registration: RegistrationService,
    private readonly passwordReset: PasswordResetService,
    private readonly config: AppConfig,
  ) {}

  @Public()
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

    if ((dto.platform ?? 'WEB') === 'WEB') {
      this.setRefreshCookie(response, result.refreshToken);
      return { tokens: result.tokens, user: result.user };
    }

    return {
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
