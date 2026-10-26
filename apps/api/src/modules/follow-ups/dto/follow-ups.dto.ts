import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LEAD_STATUSES, type LeadStatus } from '@leadflow/api-types';

const FOLLOW_UP_TYPES = ['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'OTHER'] as const;
type FollowUpTypeValue = (typeof FOLLOW_UP_TYPES)[number];

export class CreateFollowUpDto {
  @IsISO8601({}, { message: 'must be an ISO 8601 date-time' })
  scheduledAt!: string;

  @IsOptional()
  @IsIn(FOLLOW_UP_TYPES)
  type?: FollowUpTypeValue;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /**
   * Defaults to the lead's assignee. An explicit value is verified to be an
   * active member — `assigned_user_id` references the GLOBAL users table.
   */
  @IsOptional()
  @IsUUID('7')
  assignedUserId?: string;
}

export class CompleteFollowUpDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  outcome?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /**
   * The next action.
   *
   * Required by the service whenever the lead remains open — that is the "no
   * lead left behind" rule, and the database CHECK constraint enforces it too.
   */
  @IsOptional()
  @IsISO8601()
  nextFollowUpAt?: string;

  @IsOptional()
  @IsIn(FOLLOW_UP_TYPES)
  nextType?: FollowUpTypeValue;

  /** Close the lead in the same step, instead of scheduling another action. */
  @IsOptional()
  @IsIn(LEAD_STATUSES)
  leadStatus?: LeadStatus;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lostReason?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  wonValue?: number;
}

export class RescheduleFollowUpDto {
  @IsISO8601({}, { message: 'must be an ISO 8601 date-time' })
  scheduledAt!: string;

  @IsOptional()
  @IsIn(FOLLOW_UP_TYPES)
  type?: FollowUpTypeValue;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class CancelFollowUpDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class ListFollowUpsDto {
  @IsOptional()
  @IsIn(['today', 'upcoming', 'overdue', 'completed'])
  bucket?: 'today' | 'upcoming' | 'overdue' | 'completed';

  /**
   * Narrows to one person. Can only ever NARROW: a caller without team
   * visibility is restricted to their own follow-ups regardless of this value.
   */
  @IsOptional()
  @IsUUID('7')
  assignedUserId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * The activity types that represent a failed attempt.
 *
 * Exported so the web client offers exactly these and no others.
 */
export const ATTEMPT_ACTIVITY_TYPES = [
  'CALL_NOT_ANSWERED',
  'CALL_BACK_LATER',
  'WHATSAPP_OPENED',
] as const;

/**
 * A failed contact attempt, and the retry it earns.
 *
 * ONE request for the three facts about one phone call: what happened, what the
 * rep wants remembered, and when to try again. They used to need three
 * separate writes from the lead screen — log the activity, type a note, open
 * the reschedule dialog — which produced three timeline entries for one call
 * and could leave the retry unscheduled if the rep stopped halfway.
 *
 * NOTE WHAT IS ABSENT: there is no `leadStatus`. A failed attempt must not be
 * able to move the sales stage, and the way to guarantee that is to give no
 * caller the means. "Contacted" means somebody was reached.
 */
export class RecordAttemptDto {
  /**
   * Restricted to the types that mean "I tried and did not get through".
   *
   * `CALL_COMPLETED` is deliberately not here: a call that connected is an
   * outcome for the follow-up, so it belongs on the complete endpoint where a
   * stage change is a legitimate part of the conversation.
   */
  @IsIn(ATTEMPT_ACTIVITY_TYPES, {
    message: `must be one of: ${ATTEMPT_ACTIVITY_TYPES.join(', ')}`,
  })
  activityType!: (typeof ATTEMPT_ACTIVITY_TYPES)[number];

  /** Goes on the timeline entry for this attempt. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  note?: string;

  /**
   * When to try again. REQUIRED.
   *
   * A failed attempt with no retry is how a lead goes quiet: the activity is
   * logged, the overdue follow-up stays at its original date, and nobody is
   * told to try again. Making this mandatory is the fix.
   */
  @IsISO8601({}, { message: 'must be an ISO 8601 date' })
  retryAt!: string;

  /** Optionally changes how to try next — a call that failed becoming a visit. */
  @IsOptional()
  @IsIn(FOLLOW_UP_TYPES, { message: `must be one of: ${FOLLOW_UP_TYPES.join(', ')}` })
  type?: string;
}
