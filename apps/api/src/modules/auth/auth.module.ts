import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { MembershipCacheService } from './membership-cache.service';
import { SessionService } from './session.service';
import { RegistrationService } from './registration.service';
import { RegistrationRepository } from './registration.repository';
import { EmailVerificationService } from './email-verification.service';
import { EmailVerificationRepository } from './email-verification.repository';
import { PasswordResetService } from './password-reset.service';
import { GoogleAuthService } from './google-auth.service';
import { PasswordResetRepository } from './password-reset.repository';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';

/**
 * Global because the guards are registered application-wide in AppModule and
 * every module needs the membership cache to invalidate on user changes.
 */
@Global()
@Module({
  imports: [JwtModule.register({}), SubscriptionsModule],
  controllers: [AuthController],
  providers: [
    GoogleAuthService,
    AuthService,
    AuthRepository,
    PasswordService,
    TokenService,
    MembershipCacheService,
    SessionService,
    RegistrationService,
    RegistrationRepository,
    PasswordResetService,
    PasswordResetRepository,
    EmailVerificationService,
    EmailVerificationRepository,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  exports: [
    EmailVerificationService,
    AuthService,
    TokenService,
    PasswordService,
    MembershipCacheService,
    AuthRepository,
    SessionService,
  ],
})
export class AuthModule {}
