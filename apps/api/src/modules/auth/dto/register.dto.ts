import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  IsCountryCode,
  IsCurrencyCode,
  IsLocaleTag,
  IsTimezoneId,
} from '../../../common/validation/locale.validators';
import { SLUG_PATTERN } from '../../organizations/slug';

export class RegisterDto {
  @IsString()
  @MinLength(2, { message: 'must be at least 2 characters' })
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  organizationName!: string;

  /** Optional. Derived from the organization name when omitted. */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(SLUG_PATTERN, {
    message: 'may contain only lowercase letters, numbers and single hyphens',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  organizationSlug?: string;

  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  /**
   * 12 characters minimum rather than 8.
   *
   * Length dominates composition rules for real-world resistance, and this
   * account is an organization OWNER — compromising it hands over the tenant.
   */
  @IsString()
  @MinLength(12, { message: 'must be at least 12 characters' })
  @MaxLength(200)
  password!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  lastName!: string;

  /*
   * The three tenant identity settings a new organization can state at
   * registration. Each is optional; the configured deployment default applies
   * when it is absent.
   *
   * They are validated against the same ICU-backed rules as the settings
   * screen, which they previously were not: a length cap accepted country
   * "ZZ", timezone "xyz" and currency "zzz", so an organization could be
   * created with values its own settings page would then refuse to save, and
   * every date bucket and phone number in it would be read against nonsense.
   */

  /** IANA zone. Decides what "today" means in every report and follow-up. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @IsTimezoneId()
  timezone?: string;

  /** ISO 4217. Formats every amount the tenant sees. */
  @IsOptional()
  @IsString()
  @MaxLength(3)
  @IsCurrencyCode()
  currency?: string;

  /** BCP 47. Number, date and currency formatting conventions. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @IsLocaleTag()
  locale?: string;

  /**
   * ISO 3166-1 alpha-2, and the one with teeth.
   *
   * It decides how every local phone number this tenant ever enters is read
   * into E.164, and duplicate detection compares the canonical form — so the
   * wrong country here silently stops recognising the same customer twice.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2)
  @IsCountryCode()
  country?: string;

  @IsOptional()
  @IsIn(['WEB', 'ANDROID', 'IOS'])
  platform?: 'WEB' | 'ANDROID' | 'IOS';
}
