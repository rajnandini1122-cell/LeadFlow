import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * One password policy, applied everywhere a password is set.
 *
 * 12 characters minimum, no composition rules. Length dominates composition
 * for real-world resistance, and forced symbol/digit rules mostly produce
 * `Password1!` — predictable, and no stronger than a longer passphrase.
 */
const MIN_PASSWORD_LENGTH = 12;
const PASSWORD_MESSAGE = `must be at least ${MIN_PASSWORD_LENGTH} characters`;

export class ForgotPasswordDto {
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, { message: PASSWORD_MESSAGE })
  @MaxLength(200)
  password!: string;
}

export class ChangePasswordDto {
  /**
   * Required even though the caller holds a valid access token.
   *
   * Without it, a stolen 15-minute token becomes permanent account takeover:
   * the attacker simply sets a password of their own.
   */
  @IsString()
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, { message: PASSWORD_MESSAGE })
  @MaxLength(200)
  newPassword!: string;
}
