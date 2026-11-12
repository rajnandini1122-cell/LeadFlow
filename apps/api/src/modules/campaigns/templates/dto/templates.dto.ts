import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { EMAIL_CAMPAIGN_CATEGORIES } from '@leadflow/api-types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class SaveTemplateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(trim)
  name!: string;

  @IsIn(EMAIL_CAMPAIGN_CATEGORIES, {
    message: `must be one of: ${EMAIL_CAMPAIGN_CATEGORIES.join(', ')}`,
  })
  category!: (typeof EMAIL_CAMPAIGN_CATEGORIES)[number];

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(trim)
  subject!: string;

  /** Rich text from the editor. Sanitized on the server whatever the editor sent. */
  @IsString()
  @MaxLength(200_000)
  html!: string;

  /** Plain-text alternative. Generated from the HTML when empty. */
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  text?: string;
}

export class UploadAssetDto {
  @IsOptional()
  @IsUUID()
  productId?: string;
}
