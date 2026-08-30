import { Transform, Type } from 'class-transformer';
import {
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

export class CreateProductDto {
  @IsString()
  @MinLength(2, { message: 'must be at least 2 characters' })
  @MaxLength(150)
  @Transform(trim)
  name!: string;

  /**
   * The tenant's own code for this product.
   *
   * Required and unique within the organization: it is the human-stable
   * identifier a spreadsheet import would key on, and two products sharing one
   * would make both ambiguous. Uppercased so "abc-1" and "ABC-1" cannot both
   * exist and look distinct in a list.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  sku!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'must be at least 2 characters' })
  @MaxLength(150)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  sku?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListProductsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  category?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  active?: boolean;

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

/**
 * Attaching a product to leads that already exist.
 *
 * Explicit ids rather than a pattern or a search term, because the mapping is a
 * human decision. "Everything matching 'onion'" would sweep up
 * "onion storage crates" alongside "White Onion Powder", and the result would
 * be wrong in a way nobody notices until a KPI is quoted in a meeting.
 */
export class MapLeadsToProductDto {
  @IsUUID('7', { message: 'must be a valid product id' })
  productId!: string;

  @IsUUID('7', { each: true, message: 'must be valid lead ids' })
  leadIds!: string[];
}

export class ProductRangeDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  preset?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  to?: string;
}

export class UnmappedLeadsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  search?: string;

  @IsOptional()
  @IsIn(['createdAt', 'productInterest'])
  sort?: 'createdAt' | 'productInterest';
}
