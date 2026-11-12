import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MARKETING_CONSENT_BASES } from '@leadflow/api-types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

class EmailListDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  emails!: string[];
}

/** Recording WHY addresses may receive promotional mail. The note is the evidence; it is required. */
export class GrantConsentDto extends EmailListDto {
  @IsIn(MARKETING_CONSENT_BASES, {
    message: `must be one of: ${MARKETING_CONSENT_BASES.join(', ')}`,
  })
  basis!: (typeof MARKETING_CONSENT_BASES)[number];

  @IsString()
  @MinLength(5, { message: 'describe how this was obtained (at least 5 characters)' })
  @MaxLength(500)
  @Transform(trim)
  note!: string;
}

export class WithdrawConsentDto extends EmailListDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

export class SuppressDto extends EmailListDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @Transform(trim)
  note!: string;
}

export class UnsuppressDto {
  @IsString()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  @Transform(trim)
  note!: string;
}
