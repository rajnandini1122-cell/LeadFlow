import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class VerifyEmailDto {
  /**
   * The raw token from the emailed link.
   *
   * Only a length range is validated, not a shape: the token is 32 random
   * bytes in base64url, and asserting a precise alphabet here would couple the
   * public contract to how the token happens to be generated today. The
   * database lookup is the real check, and it compares a hash.
   */
  @IsString()
  @MinLength(20, { message: 'is not a valid verification token' })
  @MaxLength(200)
  token!: string;
}

export class ResendVerificationDto {
  /**
   * Lower-cased and trimmed, exactly as registration stores it — otherwise
   * "Owner@Example.com " would look like a different account and silently
   * resend nothing.
   */
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;
}
