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
  ValidateNested,
} from 'class-validator';
import {
  IsCountryCode,
  IsCurrencyCode,
  IsLocaleTag,
  IsTimezoneId,
} from '../../../common/validation/locale.validators';

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

  /**
   * Whether ordinary sales users may browse conversations nobody owns.
   *
   * Off by default. An unassigned enquiry is a customer's private message to
   * the business, not a shared noticeboard, so opening it up is a decision the
   * organization makes deliberately.
   */
  @IsOptional()
  @IsBoolean()
  sharedUnassignedQueue?: boolean;

  /**
   * Whether this organization uses omnichannel capture.
   *
   * A DISPLAY PREFERENCE, and it is worth being exact about that because the
   * name sounds like a security control. It decides whether the Inbox and
   * Channel review screens appear in the navigation — nothing more. It does not
   * gate ingestion, and it does not gate the API.
   *
   * What actually governs whether a message is accepted is the integration's
   * own `status` and `enabled` columns, checked per webhook. That is the real
   * boundary, it is per connected account rather than per tenant, and it fails
   * closed.
   *
   * Previously absent from this DTO, which — with `forbidNonWhitelisted` — meant
   * the API rejected any attempt to set it and the only way to turn omnichannel
   * on was a direct database write.
   */
  @IsOptional()
  @IsBoolean()
  omnichannelEnabled?: boolean;

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
  @IsTimezoneId()
  timezone?: string;

  /** Formats every amount the tenant sees. */
  @IsOptional()
  @IsString()
  @IsCurrencyCode()
  currency?: string;

  /** Decides number, date and currency formatting conventions. */
  @IsOptional()
  @IsString()
  @IsLocaleTag()
  locale?: string;

  /**
   * Decides how a local phone number is read into E.164.
   *
   * Not cosmetic: duplicate detection matches on the canonical form, so the
   * wrong country silently stops recognising the same customer twice.
   */
  @IsOptional()
  @IsString()
  @IsCountryCode()
  country?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateOrganizationSettingsDto)
  settings?: UpdateOrganizationSettingsDto;
}
