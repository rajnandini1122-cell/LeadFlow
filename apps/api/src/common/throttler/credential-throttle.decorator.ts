import { SetMetadata, type ExecutionContext } from '@nestjs/common';

/**
 * Marks an endpoint as credential-sensitive.
 *
 * The strict limiter — a handful of attempts per quarter hour — exists to make
 * guessing a password, a reset token or an account expensive. It is the wrong
 * instrument everywhere else: @nestjs/throttler applies every named limiter to
 * every route unless told otherwise, so without this marker the login policy
 * governed ordinary CRM reads and Meta's webhook deliveries too, and a
 * sales team behind one office IP shared five requests per fifteen minutes
 * between them.
 *
 * Opt IN, never opt out. A new endpoint is ordinary traffic until someone
 * decides it guards a credential, which is the safe direction to be wrong in:
 * the general API limit still applies to everything.
 */
export const CREDENTIAL_THROTTLE_KEY = 'leadflow:throttle:credential';

export const CredentialThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CREDENTIAL_THROTTLE_KEY, true);

/**
 * Whether the handler behind this request carries the marker.
 *
 * Read straight from the metadata rather than through a Reflector because the
 * throttler's `skipIf` hook is handed nothing but the execution context.
 */
export function isCredentialEndpoint(context: ExecutionContext): boolean {
  const handler = context.getHandler();
  const controller = context.getClass();

  return (
    Reflect.getMetadata(CREDENTIAL_THROTTLE_KEY, handler) === true ||
    Reflect.getMetadata(CREDENTIAL_THROTTLE_KEY, controller) === true
  );
}
