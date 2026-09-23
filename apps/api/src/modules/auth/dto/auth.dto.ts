import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  IsCountryCode,
  IsCurrencyCode,
  IsLocaleTag,
  IsTimezoneId,
} from '../../../common/validation/locale.validators';

export class LoginDto {
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  @IsString()
  @MinLength(8, { message: 'must be at least 8 characters' })
  @MaxLength(200)
  password!: string;

  /**
   * Which organization to sign in to. Only meaningful when the user belongs to
   * more than one; the server still verifies the membership exists and is
   * active, so supplying an arbitrary id gains nothing.
   */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid organization id' })
  organizationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceName?: string;

  @IsOptional()
  @IsIn(['WEB', 'ANDROID', 'IOS'])
  platform?: 'WEB' | 'ANDROID' | 'IOS';
}

export class RefreshDto {
  /** Omitted by web clients, which send the httpOnly cookie instead. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}

/**
 * Signing in with Google.
 *
 * The ID token is the only credential. Email and name are read from INSIDE it
 * after verification, never from the request body — a body-supplied email
 * would let a caller present their own valid Google token and be signed in as
 * somebody else.
 */
export class GoogleSignInDto {
  @IsString()
  @MaxLength(4096)
  idToken!: string;

  /** Which organization to enter, when the account belongs to several. */
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsIn(['WEB', 'ANDROID', 'IOS'])
  platform?: 'WEB' | 'ANDROID' | 'IOS';
}

/** Creating an organization for a Google account that has none yet. */
export class GoogleRegisterDto {
  @IsString()
  @MaxLength(4096)
  idToken!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  organizationName!: string;

  /*
   * The same tenant identity settings the password registration accepts, and
   * for the same reason: an organization created through Google is an
   * organization like any other, and there is no version of "you may choose
   * your country, unless you signed in with Google" that makes sense. Absent,
   * the configured deployment defaults apply — which is what this path did
   * before and still does.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @IsTimezoneId()
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  @IsCurrencyCode()
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @IsLocaleTag()
  locale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  @IsCountryCode()
  country?: string;

  @IsOptional()
  @IsIn(['WEB', 'ANDROID', 'IOS'])
  platform?: 'WEB' | 'ANDROID' | 'IOS';
}
