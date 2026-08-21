import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ListContactsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  search?: string;

  @IsOptional()
  @IsUUID('7')
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CreateContactDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Transform(trim)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  lastName?: string;

  /** Normalised to E.164 by the service against the organization's country. */
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
  @Transform(trim)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateContactDto extends CreateContactDto {}

/**
 * Which record wins for each contested field.
 *
 * Absent means the target keeps its value, which is why the merge endpoint can
 * be called with no choices at all: "keep everything from the record I am
 * merging into" is the safe default, and it is stated rather than guessed.
 */
export class MergeFieldChoicesDto {
  @IsOptional() @IsIn(['source', 'target']) firstName?: 'source' | 'target';
  @IsOptional() @IsIn(['source', 'target']) lastName?: 'source' | 'target';
  @IsOptional() @IsIn(['source', 'target']) mobile?: 'source' | 'target';
  @IsOptional() @IsIn(['source', 'target']) email?: 'source' | 'target';
  @IsOptional() @IsIn(['source', 'target']) companyName?: 'source' | 'target';
  @IsOptional() @IsIn(['source', 'target']) city?: 'source' | 'target';
  @IsOptional() @IsIn(['source', 'target']) notes?: 'source' | 'target';
}

export class MergeContactsDto {
  /** The record that is absorbed. It survives as a tombstone, never deleted. */
  @IsUUID('7', { message: 'must be a valid contact id' })
  sourceId!: string;

  /** The record that survives. Its id is the one every lead ends up pointing at. */
  @IsUUID('7', { message: 'must be a valid contact id' })
  targetId!: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => MergeFieldChoicesDto)
  fieldChoices?: MergeFieldChoicesDto;
}
