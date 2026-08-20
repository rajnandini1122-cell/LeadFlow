import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ROLE_KEYS, USER_STATUSES, type RoleKey, type UserStatus } from '@leadflow/api-types';

export class InviteUserDto {
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(150)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  fullName!: string;

  @IsIn(ROLE_KEYS, { message: `must be one of: ${ROLE_KEYS.join(', ')}` })
  role!: RoleKey;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  mobile?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  mobile?: string;

  @IsOptional()
  @IsIn(ROLE_KEYS)
  role?: RoleKey;

  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;
}
