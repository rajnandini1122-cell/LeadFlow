import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { CommonModule } from './common/common.module';
import { EmailModule } from './common/email/email.module';
import { AppConfig } from './common/config/config.module';
import { RedisService } from './common/redis/redis.service';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { isCredentialEndpoint } from './common/throttler/credential-throttle.decorator';
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
import { ProductsModule } from './modules/products/products.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { QueuesModule } from './queues/queues.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { PermissionSyncService } from './common/auth/permission-sync.service';
import { PermissionSyncRepository } from './common/auth/permission-sync.repository';
import { ContactsModule } from './modules/contacts/contacts.module';
import { OmnichannelModule } from './modules/omnichannel/omnichannel.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { ContactModule } from './modules/contact/contact.module';
import { FollowUpsModule } from './modules/follow-ups/follow-ups.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { HealthModule } from './modules/health/health.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { TeamsModule } from './modules/teams/teams.module';
import { AssignmentRulesModule } from './modules/assignment-rules/assignment-rules.module';

@Module({
  imports: [
    CommonModule,
    EmailModule,

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

    /*
     * Two abuse domains, deliberately separate, and counted in Redis.
     *
     *   default    — every route. Generous: it exists to stop a runaway
     *                client or a scraper, not to police normal work.
     *   credential — login, registration, password reset and the other
     *                endpoints where guessing is the attack. Strict, and
     *                applied ONLY to handlers carrying @CredentialThrottle().
     *
     * The `skipIf` is what makes the second policy narrow. @nestjs/throttler
     * applies every named limiter to every route unless a name is skipped, so
     * before this the login policy also governed CRM traffic, the refresh
     * endpoint and Meta's webhooks — five requests per IP per fifteen minutes
     * across a whole sales office (blocker B2).
     */
    ThrottlerModule.forRootAsync({
      inject: [AppConfig, RedisService],
      useFactory: (config: AppConfig, redis: RedisService) => ({
        storage: new RedisThrottlerStorage(redis),
        throttlers: [
          { name: 'default', ttl: config.get('THROTTLE_TTL') * 1000, limit: config.get('THROTTLE_LIMIT') },
          {
            name: 'credential',
            ttl: config.get('AUTH_THROTTLE_TTL') * 1000,
            limit: config.get('AUTH_THROTTLE_LIMIT'),
            skipIf: (context) => !isCredentialEndpoint(context),
          },
        ],
      }),
    }),

    AuthModule,
    UsersModule,
    OrganizationsModule,
    InvitationsModule,
    LeadsModule,
    ProductsModule,
    AccountsModule,
    NotificationsModule,
    ObservabilityModule,
    QueuesModule,
    ContactsModule,
    OmnichannelModule,
    FollowUpsModule,
    DashboardModule,
    ReportsModule,
    SubscriptionsModule,
    ContactModule,
    IntegrationsModule,
    TeamsModule,
    AssignmentRulesModule,
    HealthModule,
  ],
  providers: [
    // Order matters. Nest runs global guards in registration order:
    //   1. rate limiting  — cheapest rejection first, before any DB work
    //   2. authentication — establishes tenant context
    //   3. authorization  — needs the context from step 2
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    PermissionSyncService,
    PermissionSyncRepository,
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
