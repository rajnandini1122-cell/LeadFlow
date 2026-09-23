import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Trims, and turns an empty string into "not supplied". */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim()) : value;

/** Query booleans arrive as strings. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return undefined;
};

export const ACCOUNT_STATUSES = ['PROSPECT', 'CUSTOMER', 'DORMANT', 'FORMER_CUSTOMER'] as const;

export class CreateAccountDto {
  @IsString()
  @MinLength(2, { message: 'must be at least 2 characters' })
  @MaxLength(200)
  @Transform(trim)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  @Transform(trim)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  notes?: string;

  @IsOptional()
  @IsUUID('7')
  ownerId?: string;

  /**
   * Create it even though something that looks like the same company exists.
   *
   * Not a bypass of a safety check — it IS the safety check working. The
   * duplicate response names the candidates and which fields matched; this is
   * how the caller says "I have looked at those and this is a different
   * company", which is a real case with franchises and with branches a business
   * treats separately.
   *
   * Note that `status` is deliberately absent from this DTO. A new account is
   * always a PROSPECT: being a customer is earned by winning an opportunity,
   * and letting it be declared would put revenue in the acquisition figures
   * that no deal ever produced.
   */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  website?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(trim)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  @Transform(trim)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(trim)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  notes?: string;

  @IsOptional()
  @IsUUID('7')
  ownerId?: string;
}

/**
 * Reclassifying a relationship.
 *
 * Separate from UpdateAccountDto because it holds a separate permission: status
 * is what every acquisition and retention figure is counted from, so changing
 * it rewrites reported history in a way that correcting an address does not.
 */
export class ChangeAccountStatusDto {
  @IsIn(ACCOUNT_STATUSES)
  status!: (typeof ACCOUNT_STATUSES)[number];

  /** Recorded in the audit trail, so the reclassification can be understood later. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  reason?: string;
}

export class ListAccountsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  search?: string;

  @IsOptional()
  @IsIn(ACCOUNT_STATUSES)
  status?: string;

  @IsOptional()
  @IsUUID('7')
  ownerId?: string;

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

export class MergeAccountsDto {
  /**
   * The account that SURVIVES. Everything the other one owns moves here.
   *
   * Named explicitly rather than inferred from creation date or size: which
   * record a business wants to keep is a judgement about their own data, and
   * guessing it wrong means the customer ends up under a name nobody
   * recognises.
   */
  @IsUUID('7')
  survivorId!: string;
}

export class AssignToAccountDto {
  @IsUUID('7')
  accountId!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('7', { each: true })
  @ArrayMaxSize(500)
  leadIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('7', { each: true })
  @ArrayMaxSize(500)
  contactIds?: string[];
}

export class UnmappedQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class AccountRangeDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(trim)
  preset?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeInactive?: boolean;
}
