import type { ValidationError } from 'class-validator';
import { AppException } from '../errors/app.exception';

/**
 * Turns class-validator's tree into per-FIELD messages.
 *
 * This exists because of a real, user-visible defect. NestJS's ValidationPipe
 * throws a BadRequestException whose payload carries `message: string[]` — a
 * flat list like ["password must be at least 12 characters"] with the field
 * name only embedded in the prose. The exception filter mapped that array to
 * `details: { _: [...] }`, so every field's error landed under one key called
 * `_`.
 *
 * The registration form reads `fieldErrors['password']`. It never matched, so
 * nothing appeared next to any field and the user saw only the generic
 * "Request validation failed." — with no indication of WHICH field, on a form
 * with six of them. The information was collected, carried across the network,
 * and then discarded by the last step.
 *
 * So the pipe is given this factory instead: it walks the ValidationError tree
 * and produces `{ password: ["must be at least 12 characters"], ... }`, keyed by
 * property, which the existing AppException path already forwards to the client
 * and the form already knows how to render.
 *
 * Nothing about validation itself is loosened. The same constraints run, reject
 * the same payloads, and return the same 422 — `forbidNonWhitelisted` included.
 * Only the shape of the report changes.
 */
export function validationException(errors: ValidationError[]): AppException {
  const details = collect(errors);

  return AppException.validation('Request validation failed.', details);
}

/**
 * Flattens the tree into `field -> messages`.
 *
 * Nested objects are joined with dots (`address.city`), which is how a client
 * names its own fields, and array items keep their index (`items.0.sku`) so a
 * message points at the row that is wrong rather than at the whole list.
 */
function collect(errors: ValidationError[], prefix = ''): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;

    if (error.constraints) {
      /*
       * The constraint messages, with the property name stripped from the
       * front.
       *
       * class-validator writes "password must be at least 12 characters", and
       * the field name is about to be rendered next to the field itself — so
       * repeating it produces "Password: password must be at least 12
       * characters". The DTO's own `message` overrides are already written in
       * this voice ("must be at least 12 characters"), so stripping makes the
       * defaults match them.
       */
      const messages = Object.values(error.constraints).map((message) =>
        stripLeadingProperty(message, error.property),
      );

      details[path] = [...(details[path] ?? []), ...messages];
    }

    if (error.children?.length) {
      Object.assign(details, collect(error.children, path));
    }
  }

  return details;
}

/** "password must be at least 12" -> "must be at least 12". */
function stripLeadingProperty(message: string, property: string): string {
  return message.startsWith(`${property} `) ? message.slice(property.length + 1) : message;
}
