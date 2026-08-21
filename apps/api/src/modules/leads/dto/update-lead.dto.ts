import { Transform, Type } from 'class-transformer';
import {
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
} from '@leadflow/api-types';

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

  /** Re-normalised to E.164 by the service against the tenant country. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobile?: string;

  @IsOptional()
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value))
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
