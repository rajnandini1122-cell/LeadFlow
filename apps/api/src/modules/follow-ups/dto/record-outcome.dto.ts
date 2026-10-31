import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { CALL_OUTCOMES, type CallOutcome } from '@leadflow/api-types';

const FOLLOW_UP_TYPES = ['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'OTHER'] as const;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/**
 * One call, and everything it decides.
 *
 * The outcome determines which of the other fields are meaningful — see
 * CALL_OUTCOME_RULES. The DTO validates SHAPES; the service enforces the rules
 * (a requirement only on an outcome that captures one, "close" only where the
 * outcome offers it, a next action unless the lead is being closed), because
 * those depend on the outcome's value and on the lead's current state.
 *
 * There is no `leadStatus` field. The stage moves only by the rules: a first
 * real conversation advances NEW to CONTACTED, `markQualified` advances to
 * QUALIFIED where the outcome allows it, and `close` marks the lead LOST.
 */
export class RecordOutcomeDto {
  @IsIn(CALL_OUTCOMES, { message: `must be one of: ${CALL_OUTCOMES.join(', ')}` })
  outcome!: CallOutcome;

  /**
   * The follow-up this call was working.
   *
   * Optional: without it the lead's earliest open follow-up is the one worked,
   * which is what a call from the lead page means. The queue passes the row's
   * own id so the right task is completed when a lead somehow has two.
   */
  @IsOptional()
  @IsUUID('7')
  followUpId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trimmed)
  note?: string;

  /** When to act next. Required unless `close` is set. */
  @IsOptional()
  @IsISO8601({}, { message: 'must be an ISO 8601 date-time' })
  nextFollowUpAt?: string;

  @IsOptional()
  @IsIn(FOLLOW_UP_TYPES)
  nextType?: (typeof FOLLOW_UP_TYPES)[number];

  /** Advance to QUALIFIED. Honoured only for an outcome that suggests it. */
  @IsOptional()
  @IsBoolean()
  markQualified?: boolean;

  /** Close the lead as LOST instead of scheduling a next action. */
  @IsOptional()
  @IsBoolean()
  close?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trimmed)
  lostReason?: string;

  // --- the requirement, for outcomes that capture one -----------------------

  @IsOptional()
  @IsUUID('7', { message: 'must be a valid product id' })
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trimmed)
  productInterest?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trimmed)
  quantity?: string;

  /** A calendar date, YYYY-MM-DD. Never a time: "in March" has none. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be a date in YYYY-MM-DD form' })
  expectedPurchaseDate?: string;

  /** The point of contact this is about (contacts.id), when the lead has several. */
  @IsOptional()
  @IsUUID()
  contactId?: string;
}
