import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim()) : value;

const SIGNAL_KINDS = [
  'FOLLOW_UP_DUE',
  'REPEAT_CANDIDATE',
  'OPEN_OPPORTUNITY',
  'DORMANT',
  'EXPANSION_CANDIDATE',
] as const;

/**
 * Raising the next opportunity for an existing customer.
 *
 * Note what is ABSENT: no account name, no company, no contact details beyond
 * an optional override. The customer is already known and is passed in the
 * path, which is the whole point — nothing about them is re-entered, so
 * nothing about them can be duplicated.
 */
export class CreateRepeatOpportunityDto {
  /** The product they may want again. Optional: it might be something new. */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid product id' })
  productId?: string;

  /**
   * Which person at the customer. Verified to belong to THIS account, not
   * merely to the tenant.
   */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid contact id' })
  contactId?: string;

  /** What they actually asked for. Never overwrites any historical enquiry. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  productInterest?: string;

  /**
   * A forecast for THIS deal.
   *
   * Deliberately not defaulted from the previous won value. The screen offers
   * that figure as context and the salesperson decides; copying it silently
   * would turn last quarter's price into this quarter's forecast and quietly
   * destroy forecast accuracy as a measure.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  estimatedValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  mobile?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  source?: string;

  /** Every active lead needs a next action — the product promise, unchanged. */
  @IsISO8601({}, { message: 'must be an ISO 8601 date-time' })
  nextFollowUpAt!: string;
}

export class ActionQueueDto {
  @IsOptional()
  @IsIn(SIGNAL_KINDS)
  signal?: (typeof SIGNAL_KINDS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/** Scheduling an action on the CUSTOMER, with no lead involved. */
export class CreateAccountFollowUpDto {
  @IsISO8601({}, { message: 'must be an ISO 8601 date-time' })
  scheduledAt!: string;

  @IsOptional()
  @IsIn(['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'OTHER'])
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  notes?: string;

  @IsOptional()
  @IsUUID('7')
  assignedUserId?: string;
}
