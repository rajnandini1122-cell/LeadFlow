import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { TERRITORY_COVERAGE_TYPES, TERRITORY_STATUSES } from '@leadflow/api-types';
import { IsCountryCode } from '../../../common/validation/locale.validators';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTerritoryDto {
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
}

export class UpdateTerritoryDto {
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
  @IsIn(TERRITORY_STATUSES, { message: `must be one of: ${TERRITORY_STATUSES.join(', ')}` })
  status?: (typeof TERRITORY_STATUSES)[number];
}

/**
 * One geographic selector to add.
 *
 * The TYPE is explicit rather than inferred from which fields are filled in.
 * Guessing would make "IN + Maharashtra + Pune" ambiguous — a city selector
 * qualified by its state, or a state selector with a stray city — and the two
 * route different enquiries. An administrator says which they mean.
 *
 * There is no `coverageKey` here, deliberately: the canonical key is what the
 * database uses to decide who owns a place, and a caller able to choose it
 * could claim somebody else's.
 */
export class AddTerritoryCoverageDto {
  @IsIn(TERRITORY_COVERAGE_TYPES, {
    message: `must be one of: ${TERRITORY_COVERAGE_TYPES.join(', ')}`,
  })
  type!: (typeof TERRITORY_COVERAGE_TYPES)[number];

  /** ISO 3166-1 alpha-2. Required for every shape — see the service. */
  @IsString()
  @MaxLength(2)
  @IsCountryCode()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  country!: string;

  /**
   * Free text, and deliberately so.
   *
   * There is no canonical global list of states to validate against. One
   * maintained here would refuse places that exist, disagree with whatever the
   * customer's address actually says, and go stale the first time a border
   * moves. Normalisation is identity only: case and spacing.
   */
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

  /** A string, never a number: SW1A 1AA is not one, and 08540 stops being one. */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Transform(trim)
  postalCode?: string;
}

/**
 * The geography a resolution question carries.
 *
 * Everything optional, because a real enquiry is allowed to carry very little
 * — and what is missing is never invented. A submission with no pincode is not
 * a submission whose pincode can be looked up from its city.
 */
export class ResolveTerritoryDto {
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
