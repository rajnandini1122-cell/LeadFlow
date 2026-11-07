import { HttpStatus, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  ERROR_CODES,
  SUBSCRIPTION_EXPIRED_MESSAGE,
  TRIAL_EXPIRED_MESSAGE,
  isPlatformRole,
} from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { BillingService } from './billing.service';

export const ALLOW_WITHOUT_SUBSCRIPTION = 'allowWithoutSubscription';
/** Marks a route usable by an organization whose access has ended. */
export const AllowWithoutSubscription = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_WITHOUT_SUBSCRIPTION, true);

/**
 * What an organization whose trial or paid access has ended can still use:
 * signing in and out, billing and payment, plans, account and organization
 * information, notifications, its own profile and devices, and support.
 * Everything else under /api/v1 is a paid CRM feature.
 *
 * A prefix list in one place, rather than a decorator on every paid
 * controller, so a NEW CRM controller is paid by default: forgetting to mark
 * it cannot leave it open after expiry.
 */
export const OPEN_AFTER_EXPIRY: readonly string[] = [
  'auth',
  'invitations',
  'plans',
  'subscriptions',
  'billing',
  'notifications',
  'organizations',
  'workspace',
  'users/me',
  'contact',
  'platform',
  'integrations',
  'webhooks',
  'analytics',
];

export function isOpenAfterExpiry(path: string): boolean {
  const match = /^\/api\/v\d+\/(.*)$/.exec(path);
  if (!match) return true; // health, readiness, the web app itself
  const rest = match[1] ?? '';
  return OPEN_AFTER_EXPIRY.some((prefix) => rest === prefix || rest.startsWith(`${prefix}/`));
}

/**
 * Subscription enforcement, registered globally AFTER authentication and
 * permissions so the principal is known.
 *
 * Off unless SUBSCRIPTION_ENFORCEMENT_ENABLED. When on, a request from an
 * organization without access (see evaluateEntitlement) to a paid route is
 * refused with 402 SUBSCRIPTION_REQUIRED — server-side, whatever the client
 * shows. Employees are refused exactly like their owner: entitlement belongs
 * to the organization, not the person.
 *
 * A PLATFORM_OWNER membership (CRAVION platform super_admin) is never billed.
 * A tenant OWNER or ADMIN is: being an administrator of a customer is not an
 * exemption.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
    private readonly billing: BillingService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.get('SUBSCRIPTION_ENFORCEMENT_ENABLED')) return true;
    if (context.getType() !== 'http') return true;
    const principal = this.tenantContext.principal;
    if (!principal) return true; // public routes; authentication is another guard's job
    if (isPlatformRole(principal.role)) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_SUBSCRIPTION, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const path = (request.originalUrl ?? request.url).split('?')[0] ?? '';
    if (isOpenAfterExpiry(path)) return true;

    const entitlement = await this.billing.entitlement(principal.organizationId);
    if (entitlement.grantsAccess) return true;
    throw new AppException(
      ERROR_CODES.SUBSCRIPTION_REQUIRED,
      entitlement.state === 'SUSPENDED' || entitlement.state === 'DEACTIVATED'
        ? 'This organization is suspended. Contact support.'
        : entitlement.state === 'EXPIRED' || entitlement.state === 'CANCELLED'
          ? TRIAL_OR_PAID(entitlement.state)
          : TRIAL_EXPIRED_MESSAGE,
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

function TRIAL_OR_PAID(state: string): string {
  return state === 'CANCELLED' ? SUBSCRIPTION_EXPIRED_MESSAGE : TRIAL_EXPIRED_MESSAGE;
}
