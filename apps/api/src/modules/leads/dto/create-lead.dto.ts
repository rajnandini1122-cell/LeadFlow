import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  LEAD_PRIORITIES,
  LEAD_STATUSES,
  type LeadPriority,
  type LeadStatus,
} from '@idea001/api-types';

/**
 * Note what is NOT here: `organizationId`, `leadNumber`, `createdBy`.
 *
 * The tenant comes from the authenticated context, the lead number is generated
 * server-side, and the author is the caller. Accepting any of them from the
 * client would be exactly the trust the spec forbids — and the interceptor
 * strips organizationId before this DTO is even constructed.
 */
export class CreateLeadDto {
  @IsString()
  @MinLength(2, { message: 'must be at least 2 characters' })
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  firstName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  lastName?: string;

  /**
   * Indian mobile: 10 digits starting 6-9, optionally +91 prefixed.
   * Normalised to the bare 10 digits so duplicate detection compares like
   * with like — "+91 98200 11001" and "9820011001" are the same customer.
   */
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.replace(/\D/g, '').slice(-10) : value,
  )
  @Matches(/^[6-9]\d{9}$/, { message: 'must be a valid 10-digit Indian mobile number' })
  mobile!: string;

  @IsOptional()
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  productInterest?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  // Fits NUMERIC(14,2) — a larger value would be rejected by Postgres with a
  // far less helpful message.
  @Max(999_999_999_999)
  estimatedValue?: number;

  @IsOptional()
  @IsIn(LEAD_STATUSES)
  status?: LeadStatus;

  @IsOptional()
  @IsIn(LEAD_PRIORITIES)
  priority?: LeadPriority;

  @IsOptional()
  @IsUUID('7')
  assignedToId?: string;

  /**
   * Required for any non-terminal status — the "no lead left behind" rule.
   * The database CHECK constraint enforces it regardless; validating here just
   * produces a better error than a constraint violation.
   */
  @IsOptional()
  @IsISO8601({}, { message: 'must be an ISO 8601 date-time' })
  nextFollowUpAt?: string;

  /**
   * Set true to create anyway after the API reported an existing lead with the
   * same mobile. Defaults to false, so a duplicate is never created silently.
   */
  @IsOptional()
  @IsBoolean()
  allowDuplicate?: boolean;
}
