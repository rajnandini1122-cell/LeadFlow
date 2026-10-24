import { Transform } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IMPORT_DUPLICATE_MODES, type ImportDuplicateMode } from '@leadflow/api-types';

/**
 * The file is sent as text rather than multipart.
 *
 * A CSV of leads is text by definition, and keeping it in the JSON body means
 * the same validation pipe, the same tenant stripping and the same error
 * envelope apply — a separate upload path would need all three re-established.
 */
const MAX_CSV_BYTES = 2_000_000;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

class ImportPayloadDto {
  @IsString()
  @MinLength(1, { message: 'cannot be empty' })
  @MaxLength(MAX_CSV_BYTES, { message: 'file is too large' })
  csv!: string;

  /**
   * Column header → lead field. Omitted on the first preview so the server can
   * suggest one; sent back on subsequent calls once the user has adjusted it.
   *
   * An unknown field name or a header not in the file is now REFUSED rather
   * than filtered out. Silently dropping one wrong key is how a client that
   * guessed `"address"` instead of `"addressLine1"` saw a successful import
   * with no addresses in it.
   */
  @IsOptional()
  @IsObject()
  mapping?: Record<string, string>;

  /**
   * What the user called the file, for the batch record.
   *
   * Displayed back to the same tenant and never used as a path, so it needs no
   * traversal defence beyond the length limit — but it is the thing that makes
   * a batch list readable rather than a column of timestamps.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  fileName?: string;
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
   * What to do about rows matching a lead already in the CRM.
   *
   * Defaults to SKIP. Importing a file that overlaps an existing pipeline
   * should not quietly double every lead already being worked, so the safe
   * behaviour is the one you get by saying nothing.
   *
   * `CREATE_ANYWAY` still skips duplicates WITHIN the file: it means "I know
   * this customer is in the CRM and want a second lead", not "import the same
   * row twice".
   */
  @IsOptional()
  @IsIn(IMPORT_DUPLICATE_MODES, {
    message: `must be one of: ${IMPORT_DUPLICATE_MODES.join(', ')}`,
  })
  duplicateMode?: ImportDuplicateMode;
}

/**
 * A reusable column mapping.
 *
 * The name is per tenant and saving reuses it, so refining one mapping over
 * three attempts leaves one template rather than three near-identical ones.
 */
export class SaveMappingTemplateDto {
  @IsString()
  @MinLength(1, { message: 'cannot be empty' })
  @MaxLength(80)
  @Transform(trim)
  name!: string;

  @IsObject()
  mapping!: Record<string, string>;
}

export { MAX_CSV_BYTES };
