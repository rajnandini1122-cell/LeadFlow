import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { EMAIL_CAMPAIGN_CATEGORIES, EMAIL_CAMPAIGN_PURPOSES } from '@leadflow/api-types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const STRINGS = { each: true } as const;

export class RecipientFilterDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString(STRINGS)
  @MaxLength(40, STRINGS)
  statuses?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString(STRINGS)
  @MaxLength(40, STRINGS)
  priorities?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString(STRINGS)
  @MaxLength(60, STRINGS)
  sources?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString(STRINGS)
  @MaxLength(80, STRINGS)
  cities?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString(STRINGS)
  @MaxLength(80, STRINGS)
  states?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString(STRINGS)
  @MaxLength(2, STRINGS)
  countries?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', STRINGS) productIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', STRINGS) assignedToIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString(STRINGS)
  @MaxLength(80, STRINGS)
  industries?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString(STRINGS)
  @MaxLength(20, STRINGS)
  qualifications?: string[];
  @IsOptional() @IsBoolean() includeContacts?: boolean;
}

export class SaveCampaignDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  @Transform(trim)
  name!: string;

  @IsIn(EMAIL_CAMPAIGN_CATEGORIES)
  category!: (typeof EMAIL_CAMPAIGN_CATEGORIES)[number];

  @IsIn(EMAIL_CAMPAIGN_PURPOSES)
  purpose!: (typeof EMAIL_CAMPAIGN_PURPOSES)[number];

  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(trim)
  subject!: string;

  @IsString()
  @MaxLength(200_000)
  html!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  text?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUUID('all', STRINGS)
  assetIds?: string[];

  @ValidateNested()
  @Type(() => RecipientFilterDto)
  filter!: RecipientFilterDto;
}

export class AudiencePreviewDto {
  @IsIn(EMAIL_CAMPAIGN_PURPOSES)
  purpose!: (typeof EMAIL_CAMPAIGN_PURPOSES)[number];

  @ValidateNested()
  @Type(() => RecipientFilterDto)
  filter!: RecipientFilterDto;
}

/**
 * The final confirmation. `eligibleCount` is the number the person saw in the
 * dialog: if the audience changed since, the confirmation is refused rather
 * than sending to people they did not see counted.
 */
export class ConfirmCampaignDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,80}$/, {
    message: 'must be an idempotency key of 16–80 URL-safe characters',
  })
  submitKey!: string;

  @IsInt()
  @Min(1)
  eligibleCount!: number;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

export class CampaignReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  @Transform(trim)
  reason?: string;
}
