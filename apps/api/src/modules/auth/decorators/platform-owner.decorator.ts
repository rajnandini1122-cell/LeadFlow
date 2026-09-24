import { SetMetadata } from '@nestjs/common';

export const PLATFORM_OWNER_KEY = 'leadflow:platform-owner';

/**
 * Marks an endpoint as CRAVION-only.
 *
 * One decorator, checked in one guard, so platform privilege is never decided
 * by an `if` in a controller. The thing being guarded is the difference between
 * a customer administering their own organization and CRAVION administering
 * every customer, and a check written inline is a check that gets copied
 * slightly wrong.
 *
 * It is deliberately NOT expressible as `@Roles(...)`: `Roles` takes a
 * `RoleKey`, and PLATFORM_OWNER is not in that union precisely so no tenant API
 * can name it. This decorator is how an endpoint asks for it on purpose.
 *
 * Pair it with `@RequirePermissions(PERMISSIONS.PLATFORM_...)` for the specific
 * capability. The role answers "is this CRAVION", the permission answers "may
 * they do this particular thing", and both are checked.
 */
export const PlatformOwner = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PLATFORM_OWNER_KEY, true);
