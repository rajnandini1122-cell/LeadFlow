import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * A message from the public contact form.
 *
 * Every field is length-capped, because this is the one request in the system
 * whose body is written entirely by an anonymous stranger. The caps match the
 * column widths, so an over-long value is a 400 rather than a database error.
 */
export class SubmitEnquiryDto {
  @IsString()
  @MinLength(2, { message: 'please tell us your name' })
  @MaxLength(150)
  @Transform(trim)
  name!: string;

  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  company?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  phone?: string;

  @IsString()
  @MinLength(10, { message: 'please tell us a little more' })
  @MaxLength(4000)
  @Transform(trim)
  message!: string;

  /** Which page the enquiry came from. Attribution only. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  source?: string;

  /**
   * Honeypot.
   *
   * Hidden from people by the form and left blank by them; bots fill every
   * field they find. Declared here rather than silently dropped because the
   * global ValidationPipe runs with `forbidNonWhitelisted`, so an undeclared
   * field would be rejected outright and the trap would never spring.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}
