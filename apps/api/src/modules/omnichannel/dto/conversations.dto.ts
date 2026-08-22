import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
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
  ValidateIf,
} from 'class-validator';

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

export class InboxQueryDto {
  @ApiPropertyOptional({ enum: ['ALL', 'MINE', 'UNASSIGNED'] })
  @IsOptional()
  @IsIn(['ALL', 'MINE', 'UNASSIGNED'])
  filter?: string;

  @ApiPropertyOptional({ enum: ['WHATSAPP', 'FACEBOOK', 'INSTAGRAM'] })
  @IsOptional()
  @IsIn(['WHATSAPP', 'FACEBOOK', 'INSTAGRAM'])
  channel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Id of the last row from the previous page.' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export class AssignConversationDto {
  @ApiPropertyOptional({
    description: 'Who should handle this conversation. Null hands it back to nobody.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  userId?: string | null;
}

export class SetIntegrationEnabledDto {
  @ApiProperty({ description: 'Whether this integration should be acted on.' })
  @IsBoolean()
  enabled!: boolean;
}

export class ConnectWhatsAppDto {
  @ApiProperty({ description: "Meta's id for the business phone number." })
  @IsString()
  @MaxLength(120)
  phoneNumberId!: string;

  @ApiPropertyOptional({ description: 'WhatsApp Business Account id, for diagnostics.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  businessAccountId?: string;

  /**
   * A permanent access token from the Meta app.
   *
   * Write-only: it is encrypted immediately and never returned by any endpoint.
   * Only the last four characters are ever readable again.
   */
  @ApiProperty({ description: 'Permanent access token. Stored encrypted; never returned.' })
  @IsString()
  @MaxLength(1000)
  accessToken!: string;
}

export class ArchiveConversationDto {
  @ApiPropertyOptional({ description: 'Why this is not a lead. Shown to whoever looks later.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
