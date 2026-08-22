import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

export class SendMessageDto {
  /**
   * The reply text, or a caption when a file is attached.
   *
   * Optional as of media support: a photo on its own is a complete message,
   * and requiring text would make the user type something to send one. Text-only
   * requests are unchanged — the service still refuses a message with neither.
   */
  @ApiPropertyOptional({ description: 'The reply text, or a caption for an attachment.' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  content?: string;

  /**
   * Makes the request repeatable.
   *
   * The client generates one per composed message and reuses it on retry, so a
   * double click, a browser retry or a network timeout cannot send a customer
   * two copies of the same reply.
   */
  @ApiProperty({ description: 'Client-generated key, reused on retry.' })
  @IsString()
  @MaxLength(120)
  idempotencyKey!: string;
}

/**
 * Sending an approved template.
 *
 * Carries a template NAME and the values for its placeholders — never a body,
 * never a component structure. What the customer receives is fixed by the
 * definition Meta approved, and the only thing a client gets to decide is which
 * approved template and what goes in its blanks. Accepting text here would be
 * accepting a free-form message dressed as a template, which is precisely what
 * the 24-hour window exists to prevent.
 */
export class SendTemplateDto {
  @ApiProperty({ description: "Meta's name for the approved template." })
  @IsString()
  @MaxLength(200)
  templateName!: string;

  @ApiProperty({ description: 'The template language code, e.g. en_US.' })
  @IsString()
  @MaxLength(20)
  language!: string;

  /**
   * Values for the header's placeholders, in order.
   *
   * The COUNT is checked against the stored definition, not against what the
   * client sends — a request claiming a template needs no values does not get
   * to send one with `{{1}}` left in the text.
   */
  @ApiPropertyOptional({ description: "Values for the header's placeholders, in order." })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  @ArrayMaxSize(10)
  headerParameters?: string[];

  @ApiPropertyOptional({ description: "Values for the body's placeholders, in order." })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  @ArrayMaxSize(10)
  bodyParameters?: string[];

  /** Same guarantee as a free-form send: a retry cannot send a second copy. */
  @ApiProperty({ description: 'Client-generated key, reused on retry.' })
  @IsString()
  @MaxLength(120)
  idempotencyKey!: string;
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

/**
 * Connecting an Instagram account or a Facebook Page.
 *
 * One DTO for both, because both need exactly the same three values. The
 * endpoint decides which channel it is; the shape does not differ.
 */
export class ConnectMessengerDto {
  @ApiProperty({
    description: 'The Instagram professional account id, or the Facebook Page id.',
  })
  @IsString()
  @MaxLength(120)
  accountId!: string;

  @ApiPropertyOptional({
    description: 'For Instagram, the linked Facebook Page id. Unused for Messenger.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  linkedAccountId?: string;

  /** Write-only: encrypted immediately and never returned by any endpoint. */
  @ApiProperty({ description: 'Access token. Stored encrypted; never returned.' })
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
