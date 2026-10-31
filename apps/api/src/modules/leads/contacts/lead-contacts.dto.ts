import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { clearableText, optionalEmail, optionalText } from '../dto/contact-fields';

/** Blank means "clear it" on an edit, like `clearableText`, for an email. */
const clearableEmail = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const cleaned = optionalEmail({ value });
  return cleaned === undefined ? null : cleaned;
};

/**
 * One person to add to a lead.
 *
 * A name is required: a point of contact nobody can address by name is not
 * one. Phone and email are optional -- a buyer known only by email is real.
 */
export class LeadContactInputDto {
  @Transform(optionalText)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(100)
  designation?: string;

  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(60)
  department?: string;

  /** Any format; canonicalised to E.164 with the organization's country. */
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(30)
  mobile?: string;

  /** Only when WhatsApp is on a different number from `mobile`. */
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(30)
  whatsapp?: string;

  @IsOptional()
  @Transform(optionalEmail)
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** Make this person the lead's primary contact. */
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class AddLeadContactDto extends LeadContactInputDto {
  /**
   * Add even though somebody with the same phone or email is already on this
   * lead or at this company. Without it the API answers DUPLICATE_CONTACT.
   */
  @IsOptional()
  @IsBoolean()
  allowDuplicate?: boolean;
}

/**
 * An edit. Every field optional; `null` or blank clears an optional field.
 * The name cannot be cleared.
 */
export class UpdateLeadContactDto {
  @IsOptional()
  @Transform(optionalText)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @Transform(clearableText)
  @IsString()
  @MaxLength(80)
  lastName?: string | null;

  @IsOptional()
  @Transform(clearableText)
  @IsString()
  @MaxLength(100)
  designation?: string | null;

  @IsOptional()
  @Transform(clearableText)
  @IsString()
  @MaxLength(60)
  department?: string | null;

  @IsOptional()
  @Transform(clearableText)
  @IsString()
  @MaxLength(30)
  mobile?: string | null;

  @IsOptional()
  @Transform(clearableText)
  @IsString()
  @MaxLength(30)
  whatsapp?: string | null;

  @IsOptional()
  @Transform(clearableEmail)
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  email?: string | null;

  @IsOptional()
  @Transform(clearableText)
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsBoolean()
  allowDuplicate?: boolean;
}
