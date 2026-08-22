import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, MaxLength } from 'class-validator';

export class ListConversationsDto {
  @ApiProperty({ description: 'The lead whose conversations to return.' })
  @IsUUID()
  leadId!: string;
}

export class LinkConversationDto {
  @ApiProperty({ description: 'The existing lead to attach this conversation to.' })
  @IsUUID()
  leadId!: string;
}

/** The piles a reviewer works through. */
export const REVIEW_CATEGORIES = [
  'ALL',
  'POTENTIAL_LEAD',
  'UNRESOLVED',
  'UNLINKED',
  'REVIEW_REQUIRED',
  'LINKED',
] as const;

export class ReviewQueueDto {
  @ApiPropertyOptional({ enum: REVIEW_CATEGORIES })
  @IsOptional()
  @IsIn(REVIEW_CATEGORIES as unknown as string[])
  category?: string;

  @ApiPropertyOptional({ enum: ['WHATSAPP', 'FACEBOOK', 'INSTAGRAM'] })
  @IsOptional()
  @IsIn(['WHATSAPP', 'FACEBOOK', 'INSTAGRAM'])
  channel?: string;

  @ApiPropertyOptional({ description: 'Show dismissed conversations instead of active ones.' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ArchiveConversationDto {
  @ApiPropertyOptional({ description: 'Why this is not a lead. Shown to whoever looks later.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
