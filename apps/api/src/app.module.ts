import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { CommonModule } from './common/common.module';
import { AppConfig } from './common/config/config.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { StripTenantFieldsInterceptor } from './common/tenancy/strip-tenant-fields.interceptor';
import { TenantContextService } from './common/tenancy/tenant-context.service';

import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { UsersModule } from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { LeadsModule } from './modules/leads/leads.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    CommonModule,

    // AsyncLocalStorage-backed request context. `mount: true` wraps every HTTP
    // request; workers open their own scope via runWithTenant().
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: IncomingMessage & { id?: unknown }) => String(req.id ?? randomUUID()),
      },
    }),

    // Structured logging (spec §28). Every line carries request_id; the
    // customProps hook adds user_id and organization_id once authenticated.
    LoggerModule.forRootAsync({
      inject: [AppConfig, TenantContextService],
      useFactory: (config: AppConfig, tenantContext: TenantContextService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          genReqId: (req: IncomingMessage & { id?: unknown }) => String(req.id ?? randomUUID()),
          customProps: () => ({
            user_id: tenantContext.userId ?? null,
            organization_id: tenantContext.organizationId ?? null,
          }),
          // Never log credentials or tokens, in any environment.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.refreshToken',
              'res.headers["set-cookie"]',
            ],
            remove: true,
          },
          autoLogging: {
            ignore: (req: IncomingMessage) =>
              req.url === '/health' || req.url === '/readiness',
          },
          ...(config.isProduction
            ? {}
            : { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
          customSuccessMessage: (req: IncomingMessage, res: ServerResponse) =>
            `${req.method} ${req.url} ${res.statusCode}`,
        },
      }),
    }),

    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          { name: 'default', ttl: config.get('THROTTLE_TTL') * 1000, limit: config.get('THROTTLE_LIMIT') },
          { name: 'auth', ttl: config.get('AUTH_THROTTLE_TTL') * 1000, limit: config.get('AUTH_THROTTLE_LIMIT') },
        ],
      }),
    }),

    AuthModule,
    UsersModule,
    OrganizationsModule,
    InvitationsModule,
    LeadsModule,
    HealthModule,
  ],
  providers: [
    // Order matters. Nest runs global guards in registration order:
    //   1. rate limiting  — cheapest rejection first, before any DB work
    //   2. authentication — establishes tenant context
    //   3. authorization  — needs the context from step 2
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    // Interceptors run outermost-first on the way in: tenant fields are
    // stripped before any handler or pipe can observe them.
    { provide: APP_INTERCEPTOR, useClass: StripTenantFieldsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },

    {
      provide: APP_FILTER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new AllExceptionsFilter(config.isProduction),
    },
  ],
})
export class AppModule {}
