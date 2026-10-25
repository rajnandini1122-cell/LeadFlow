import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ATTACHMENT_KINDS, type AttachmentKind } from './attachment-file-type';

/**
 * The form fields that travel with an uploaded file (multipart), so every
 * value arrives as a string and is converted here.
 */
export class UploadAttachmentDto {
  @IsIn(ATTACHMENT_KINDS, { message: `must be one of: ${ATTACHMENT_KINDS.join(', ')}` })
  kind!: AttachmentKind;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value))
  note?: string;

  /** The quoted or invoiced amount, in the organization's currency. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  amount?: number;

  /**
   * For a quotation: it was sent to the customer. Moves the stage forward to
   * Quotation sent, which puts the lead in Awaiting response.
   */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  markQuotationSent?: boolean;
}
