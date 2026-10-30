import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
  MAX_ADDITIONAL_CONTACTS,
} from '@leadflow/api-types';
import { optionalText, emailList, optionalEmail, phoneList } from './contact-fields';

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

  /** The person's role at the customer, e.g. "Purchase Manager". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(optionalText)
  designation?: string;

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

  /*
   * Trimmed and lower-cased, like every other email this product stores.
   *
   * It was not, until `leads_org_email_uniq` made the address a duplicate key:
   * the website intake DTO has always normalised, these did not, so the same
   * customer could arrive as `Dana@Example.test` from one path and
   * `dana@example.test` from another. The index keys on lower(email) so it
   * catches that regardless, and normalising here keeps what is STORED
   * consistent too rather than relying on the index to paper over it.
   */
  @IsOptional()
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(optionalEmail)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  /*
   * The rest of the address. The columns arrived with 20261013090000 for the
   * CSV import; until 2026-10-30 nothing else could write them, so a full
   * address typed by hand ended up crammed into `city`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(optionalText)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(optionalText)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(optionalText)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(optionalText)
  postalCode?: string;

  /*
   * Other ways to reach the same customer — an office landline, a second
   * mobile, a personal address. Up to {MAX} each. Phones are canonicalised to
   * E.164 by the service (same rule as `mobile`); neither list is a duplicate
   * key: only the primary mobile and email identify a lead.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ADDITIONAL_CONTACTS, { message: `at most ${MAX_ADDITIONAL_CONTACTS} additional phone numbers` })
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  @Transform(phoneList)
  additionalPhones?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ADDITIONAL_CONTACTS, { message: `at most ${MAX_ADDITIONAL_CONTACTS} additional email addresses` })
  @IsEmail({}, { each: true, message: 'each must be a valid email address' })
  @MaxLength(320, { each: true })
  @Transform(emailList)
  additionalEmails?: string[];

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
