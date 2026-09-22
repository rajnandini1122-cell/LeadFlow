import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ASSIGNMENT_RULE_STATUSES } from '@leadflow/api-types';
import { IsCountryCode } from '../../../common/validation/locale.validators';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAssignmentRuleDto {
  @IsString()
  @MinLength(2, { message: 'must be at least 2 characters' })
  @MaxLength(80)
  @Transform(trim)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  description?: string;

  /**
   * Lower runs first.
   *
   * Optional: omitted, the server places the rule after the current
   * lowest-precedence one. Bounded because precedence is a small ordered list
   * an administrator reads, not an arithmetic space.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  priority?: number;

  /**
   * The lead source to match, in the tenant's own vocabulary.
   *
   * Not validated against their configured list: sources are free text here,
   * a list can change under a rule, and refusing to store a rule for a source
   * somebody is about to add would be an odd thing to do.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  source?: string;

  /** A CANONICAL product id. Free text is never routed on. */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid product id' })
  productId?: string;

  /**
   * A RESOLVED territory id. Never a country, state, city or pincode.
   *
   * Raw geography belongs to the territory resolver, which owns the coverage
   * table and the specificity order. Accepting a city here would make every
   * rule its own geography database, and the first two that disagreed would
   * route the same enquiry two ways.
   */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid territory id' })
  territoryId?: string;

  /** The catch-all. A fallback carries no criteria — see the service. */
  @IsOptional()
  @IsBoolean()
  isFallback?: boolean;

  @IsUUID('7', { message: 'must be a valid team id' })
  targetTeamId!: string;
}

export class UpdateAssignmentRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  description?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  priority?: number;

  /** Null clears the criterion, meaning "any source". */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  source?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('7', { message: 'must be a valid product id' })
  productId?: string | null;

  /** Null clears the criterion, meaning "anywhere". */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('7', { message: 'must be a valid territory id' })
  territoryId?: string | null;

  @IsOptional()
  @IsUUID('7', { message: 'must be a valid team id' })
  targetTeamId?: string;

  @IsOptional()
  @IsIn(ASSIGNMENT_RULE_STATUSES, {
    message: `must be one of: ${ASSIGNMENT_RULE_STATUSES.join(', ')}`,
  })
  status?: (typeof ASSIGNMENT_RULE_STATUSES)[number];
}

/**
 * The facts a preview supplies.
 *
 * Deliberately the same shape the evaluator takes from a real piece of work,
 * so a preview answers the question production will ask rather than a
 * simplified version of it.
 */
export class PreviewAssignmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  source?: string;

  @IsOptional()
  @IsUUID('7', { message: 'must be a valid product id' })
  productId?: string;

  /*
   * Geography arrives RAW here and nowhere else in the routing path.
   *
   * The preview resolves it to a territory first, exactly as the phase that
   * turns an enquiry into a lead will, so what an administrator tests is what
   * production does. The rules themselves still never see a city or a pincode
   * — they match the territory id that comes back.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2)
  @IsCountryCode()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Transform(trim)
  postalCode?: string;
}
