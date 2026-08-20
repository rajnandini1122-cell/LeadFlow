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
