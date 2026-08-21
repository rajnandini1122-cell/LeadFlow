import {
  IsBoolean,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * The file is sent as text rather than multipart.
 *
 * A CSV of leads is text by definition, and keeping it in the JSON body means
 * the same validation pipe, the same tenant stripping and the same error
 * envelope apply — a separate upload path would need all three re-established.
 */
const MAX_CSV_BYTES = 2_000_000;

class ImportPayloadDto {
  @IsString()
  @MinLength(1, { message: 'cannot be empty' })
  @MaxLength(MAX_CSV_BYTES, { message: 'file is too large' })
  csv!: string;

  /**
   * Column header → lead field. Omitted on the first preview so the server can
   * suggest one; sent back on subsequent calls once the user has adjusted it.
   */
  @IsOptional()
  @IsObject()
  mapping?: Record<string, string>;
}

export class PreviewImportDto extends ImportPayloadDto {
  @IsOptional()
  @IsISO8601()
  defaultNextFollowUpAt?: string;
}

/**
 * Deliberately extends the shared payload rather than the preview DTO.
 *
 * `defaultNextFollowUpAt` is optional for a preview and required for a real
 * import, and class-validator inherits a parent's `@IsOptional()` — subclassing
 * the preview would leave the field optional here no matter what this class
 * declares, and every row would then fail the database CHECK constraint.
 */
export class ImportLeadsDto extends ImportPayloadDto {
  /**
   * Every active lead must have a next action, so a file with no follow-up
   * column needs one date for the whole batch.
   */
  @IsISO8601()
  defaultNextFollowUpAt!: string;

  /** Verified to be an active member of this organization before any row runs. */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid user id' })
  assignedToId?: string;

  /**
   * Defaults to skipping. Importing a file that overlaps an existing pipeline
   * should not quietly double every lead already being worked.
   */
  @IsOptional()
  @IsBoolean()
  skipDuplicates?: boolean;
}

export { MAX_CSV_BYTES };
