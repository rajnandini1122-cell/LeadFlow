import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'leadflow:isPublic';

/**
 * Opts a route out of authentication.
 *
 * Guards are global and deny by default, so forgetting a decorator makes a
 * route inaccessible rather than unprotected — the failure mode that gets
 * noticed immediately instead of the one that leaks data.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
