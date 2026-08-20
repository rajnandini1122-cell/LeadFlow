import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { MembershipCacheService } from './membership-cache.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';

/**
 * Global because the guards are registered application-wide in AppModule and
 * every module needs the membership cache to invalidate on user changes.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    PasswordService,
    TokenService,
    MembershipCacheService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  exports: [AuthService, TokenService, PasswordService, MembershipCacheService, AuthRepository],
})
export class AuthModule {}
