import { Transform } from 'class-transformer';
import {
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  isValidCountry,
  isValidCurrency,
  isValidLocale,
  isValidTimezone,
} from '../utils/locale';

/**
 * Tenant identity validators, defined once.
 *
 * Every check asks the runtime's own ICU data rather than a list in source: a
 * hand-kept list of countries or currencies is wrong the moment one changes,
 * and the symptom is a tenant who cannot save their own settings. It is also
 * why the timezone check is not a regex — the obvious one rejects `UTC`, which
 * has no slash, and `America/Argentina/Buenos_Aires`, which has two.
 *
 * These lived inside the organizations DTO, where registration could not reach
 * them; registration therefore validated nothing but length, and could create a
 * tenant in country "ZZ" with timezone "xyz" that its own settings screen would
 * then refuse to save. One definition, used by every entry point, is what keeps
 * those two answers the same.
 */

@ValidatorConstraint({ name: 'isTimezone' })
export class IsTimezoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidTimezone(value);
  }
  defaultMessage(): string {
    return 'must be an IANA timezone, e.g. Asia/Kolkata or UTC';
  }
}

@ValidatorConstraint({ name: 'isCurrency' })
export class IsCurrencyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidCurrency(value);
  }
  defaultMessage(): string {
    return 'must be a three-letter ISO 4217 currency code, e.g. INR';
  }
}

@ValidatorConstraint({ name: 'isLocale' })
export class IsLocaleConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidLocale(value);
  }
  defaultMessage(): string {
    return 'must be a BCP 47 locale, e.g. en-IN';
  }
}

@ValidatorConstraint({ name: 'isCountry' })
export class IsCountryConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidCountry(value);
  }
  defaultMessage(): string {
    return 'must be a two-letter ISO 3166-1 country code, e.g. IN';
  }
}

/**
 * Upper-cases before validation, so "in" and "inr" are accepted and stored
 * canonically.
 *
 * Case is not a mistake worth refusing a registration over, and correcting it
 * at the edge is what stops the same country being written two ways and then
 * compared as two different values.
 */
const upperCase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * BCP 47 has a canonical casing — en-IN, not en-in — and ICU knows it.
 *
 * Correcting it matters because the tag is read back by Intl on both the
 * server and in the browser, and because a tenant stored as "en-in" compares
 * unequal to every other tenant on the same locale.
 */
const canonicalLocale = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;

  const tag = value.trim();
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? tag;
  } catch {
    // Structurally invalid; leave it alone so the validator can say so.
    return tag;
  }
};

/** ISO 3166-1 alpha-2, upper-cased. */
export const IsCountryCode = (): PropertyDecorator =>
  applyAll(Transform(upperCase), Validate(IsCountryConstraint));

/** ISO 4217, upper-cased. */
export const IsCurrencyCode = (): PropertyDecorator =>
  applyAll(Transform(upperCase), Validate(IsCurrencyConstraint));

/** BCP 47, in ICU's own canonical casing. */
export const IsLocaleTag = (): PropertyDecorator =>
  applyAll(Transform(canonicalLocale), Validate(IsLocaleConstraint));

/** IANA zone identifiers are case-SENSITIVE, so only whitespace is stripped. */
export const IsTimezoneId = (): PropertyDecorator =>
  applyAll(Transform(trimmed), Validate(IsTimezoneConstraint));

function applyAll(...decorators: PropertyDecorator[]): PropertyDecorator {
  return (target, key) => {
    for (const decorate of decorators) decorate(target, key);
  };
}
