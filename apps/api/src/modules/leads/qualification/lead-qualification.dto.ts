import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { QUALIFICATION_NOTE_OUTCOMES, REFINEMENT_OUTCOMES } from '@leadflow/api-types';
import { optionalText } from '../dto/contact-fields';

const NOTE_OUTCOMES = Object.keys(QUALIFICATION_NOTE_OUTCOMES);
const REFINE_OUTCOMES = Object.keys(REFINEMENT_OUTCOMES);

/** Qualification work on a Rough lead: what was found, and optionally when to look again. */
export class QualificationNoteDto {
  @IsIn(NOTE_OUTCOMES, { message: `must be one of: ${NOTE_OUTCOMES.join(', ')}` })
  outcome!: string;

  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** The new qualify-by date (the lead's next action while Rough). Must be in the future. */
  @IsOptional()
  @IsISO8601({}, { message: 'must be an ISO 8601 date-time' })
  nextQualificationAt?: string;

  /** The point of contact spoken to, when there was one. */
  @IsOptional()
  @IsUUID()
  contactId?: string;
}

export class RefineLeadDto {
  @IsIn(REFINE_OUTCOMES, { message: `must be one of: ${REFINE_OUTCOMES.join(', ')}` })
  outcome!: string;

  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** The person refining confirms the business fit. Must be true. */
  @IsBoolean()
  businessFitConfirmed!: boolean;
}

export class RevertToRoughDto {
  @Transform(optionalText)
  @IsString()
  @MinLength(5, { message: 'give a reason of at least 5 characters' })
  @MaxLength(500)
  reason!: string;
}
