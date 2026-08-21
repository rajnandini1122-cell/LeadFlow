import { Type } from 'class-transformer';
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
