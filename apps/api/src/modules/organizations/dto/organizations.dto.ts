import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  isValidCountry,
  isValidCurrency,
  isValidLocale,
  isValidTimezone,
} from '../../../common/utils/locale';

/**
 * Locale validators backed by the runtime's own ICU data.
 *
 * A regex or a hand-maintained list is wrong the moment the tz database or the
 * ISO 4217 list changes, and the symptom is a tenant unable to save their own
 * settings — which is exactly how the previous timezone regex behaved for
 * anyone on `UTC` or `America/Argentina/Buenos_Aires`.
 */
@ValidatorConstraint({ name: 'isTimezone' })
class IsTimezoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidTimezone(value);
  }
  defaultMessage(): string {
    return 'must be an IANA timezone, e.g. Europe/London or UTC';
  }
}

@ValidatorConstraint({ name: 'isCurrency' })
class IsCurrencyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidCurrency(value);
  }
  defaultMessage(): string {
    return 'must be a three-letter ISO 4217 currency code, e.g. USD';
  }
}

@ValidatorConstraint({ name: 'isLocale' })
class IsLocaleConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidLocale(value);
  }
  defaultMessage(): string {
    return 'must be a BCP 47 locale, e.g. en-GB';
  }
}

@ValidatorConstraint({ name: 'isCountry' })
class IsCountryConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidCountry(value);
  }
  defaultMessage(): string {
    return 'must be a two-letter ISO 3166-1 country code, e.g. GB';
  }
}

export class UpdateOrganizationSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  followupReminderMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  followupOverdueMinutes?: number;

  @IsOptional()
  @IsBoolean()
  escalateToManager?: boolean;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:MM in 24-hour form' })
  workingHoursStart?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:MM in 24-hour form' })
  workingHoursEnd?: string;

  /**
   * The source options offered when creating a lead.
   *
   * Per-tenant rather than a fixed list, because "where did this enquiry come
   * from" is a question every business answers differently, and a hardcoded
   * list makes the field useless for anyone it does not fit.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  @Transform(({ value }) =>
    Array.isArray(value)
      ? // Trimmed and de-duplicated, so "Referral" and "Referral " cannot both
        // appear in the dropdown as apparently different options.
        [...new Set(value.map((entry) => (typeof entry === 'string' ? entry.trim() : entry)))].filter(
          (entry) => entry !== '',
        )
      : value,
  )
  leadSources?: string[];
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  /** Decides what "today" means in every report and follow-up bucket. */
  @IsOptional()
  @IsString()
  @Validate(IsTimezoneConstraint)
  timezone?: string;

  /** Formats every amount the tenant sees. */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Validate(IsCurrencyConstraint)
  currency?: string;

  /** Decides number, date and currency formatting conventions. */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Validate(IsLocaleConstraint)
  locale?: string;

  /**
   * Decides how a local phone number is read into E.164.
   *
   * Not cosmetic: duplicate detection matches on the canonical form, so the
   * wrong country silently stops recognising the same customer twice.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Validate(IsCountryConstraint)
  country?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateOrganizationSettingsDto)
  settings?: UpdateOrganizationSettingsDto;
}
