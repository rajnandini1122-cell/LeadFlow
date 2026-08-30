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
} from '@leadflow/api-types';

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
   * Raw phone input, in whatever form the user typed it.
   *
   * Normalised to E.164 by the service using the ORGANIZATION's country, not
   * a hardcoded region — the same national number means different people in
   * different countries. Validation is intentionally loose here and strict
   * there, because only the service knows the tenant.
   *
   * OPTIONAL, which it has to be. A lead created from an Instagram or
   * Messenger conversation has no phone number to offer: those platforms give
   * an opaque, provider-scoped account id and nothing else, and the customer
   * has not necessarily typed a number anywhere. Requiring one made "create a
   * lead" impossible from exactly the conversations the review queue exists to
   * triage — the person would have to invent a number, which is worse than
   * having none.
   *
   * The database has always permitted this: `leads.mobile` is nullable and the
   * duplicate index is `WHERE mobile IS NOT NULL`. Only this DTO stood in the
   * way.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/[0-9]/, { message: 'must contain digits' })
  /*
   * An empty string becomes undefined BEFORE validation.
   *
   * `@IsOptional()` only skips `undefined` and `null`, so a form that submits
   * "" for an untouched field would otherwise fail the digits rule — the user
   * would be told their blank optional field "must contain digits", which is
   * both wrong and impossible to act on.
   */
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  mobile?: string;

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

  /**
   * The standardised product this enquiry is for.
   *
   * Optional, and separate from productInterest below. This is the grouping key
   * every product KPI uses; the free text is what the customer actually asked
   * for. Both are kept — "White Onion Powder" cannot carry "500 kg monthly,
   * food manufacturing use", and losing that detail would cost more than the
   * grouping gains.
   */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid product id' })
  productId?: string;

  /**
   * The customer this opportunity belongs to.
   *
   * Optional and permanently so: an enquiry can legitimately come from a
   * private individual, or from a company nobody has recorded yet. Attaching
   * one is what makes a repeat customer's second enquiry show up as repeat
   * business rather than as a new customer.
   */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid account id' })
  accountId?: string;

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
