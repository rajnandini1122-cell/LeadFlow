import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ACTIVITY_TYPES,
  LEAD_PRIORITIES,
  LEAD_STATUSES,
  type ActivityType,
  type LeadPriority,
  type LeadStatus,
  MAX_ADDITIONAL_CONTACTS,
} from '@leadflow/api-types';
import { clearableText, emailList, optionalEmail, phoneList } from './contact-fields';

/**
 * Partial update. Every field optional — PATCH semantics.
 *
 * `exactOptionalPropertyTypes` is what makes this trustworthy: "field absent"
 * and "field explicitly null" stay distinguishable, so clearing a value is a
 * different instruction from leaving it alone.
 */
export class UpdateLeadDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  /** The person's role at the customer, e.g. "Purchase Manager". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(clearableText)
  designation?: string | null;

  /** Re-normalised to E.164 by the service against the tenant country. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobile?: string;

  /* Normalised like every other email this product stores — see create-lead.dto. */
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
  @Transform(clearableText)
  addressLine1?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(clearableText)
  addressLine2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(clearableText)
  state?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(clearableText)
  postalCode?: string | null;

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
   * Null detaches it, which is the honest option when a lead turns out to have
   * been filed under the wrong company — better than leaving it attached to a
   * customer whose figures it then distorts.
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
  @Max(999_999_999_999)
  estimatedValue?: number;

  @IsOptional()
  @IsIn(LEAD_PRIORITIES)
  priority?: LeadPriority;

  @IsOptional()
  @IsIn(LEAD_STATUSES)
  status?: LeadStatus;

  /** Required by the service when moving to LOST. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  lostReason?: string;

  /** What the deal actually closed at. Only meaningful with status WON. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  wonValue?: number;

  @IsOptional()
  @IsISO8601()
  nextFollowUpAt?: string;
}

export class AssignLeadDto {
  /**
   * The new owner. Verified to be an active member of the caller's
   * organization — `leads.assigned_to` references the GLOBAL users table, so
   * nothing in the schema would stop a foreign id.
   */
  @IsUUID('7', { message: 'must be a valid user id' })
  assignedToId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class CreateNoteDto {
  @IsString()
  @MinLength(1, { message: 'cannot be empty' })
  @MaxLength(2000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  body!: string;
}

/** Activity types a client may log directly. */
const LOGGABLE: ActivityType[] = [
  'CALL_COMPLETED',
  'CALL_NOT_ANSWERED',
  'CALL_BACK_LATER',
  'WHATSAPP_OPENED',
  'WHATSAPP_SENT',
  'NOTE_ADDED',
];

export class LogActivityDto {
  /**
   * Restricted to the types a user genuinely performs.
   *
   * System events — LEAD_CREATED, STATUS_CHANGED, FOLLOW_UP_COMPLETED — are
   * written by the server as a side effect of the real action. Accepting them
   * here would let a client fabricate history that never happened.
   */
  @IsIn(LOGGABLE, { message: `must be one of: ${LOGGABLE.join(', ')}` })
  activityType!: ActivityType;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** Schedules the next action in the same request, after a call. */
  @IsOptional()
  @IsISO8601()
  nextFollowUpAt?: string;
}

export const LOGGABLE_ACTIVITY_TYPES = LOGGABLE;
export { ACTIVITY_TYPES };
