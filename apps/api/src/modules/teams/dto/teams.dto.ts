import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { TEAM_STATUSES } from '@leadflow/api-types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateTeamDto {
  @IsString()
  @MinLength(2, { message: 'must be at least 2 characters' })
  @MaxLength(80)
  @Transform(trim)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  description?: string;

  /**
   * A USER id, not a membership id.
   *
   * Every other endpoint in this product identifies a colleague by user id —
   * assignment, workload, offboarding — and introducing a second vocabulary at
   * one screen would mean the web app carrying both. The membership it belongs
   * to is resolved server-side, which is also where the tenant check happens.
   */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid user id' })
  managerUserId?: string;
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Transform(trim)
  name?: string;

  /** Null clears the description; omitting it leaves the current one. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  description?: string | null;

  /** Null clears the manager; omitting it leaves the current one. */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID('7', { message: 'must be a valid user id' })
  managerUserId?: string | null;

  @IsOptional()
  @IsIn(TEAM_STATUSES, { message: `must be one of: ${TEAM_STATUSES.join(', ')}` })
  status?: (typeof TEAM_STATUSES)[number];
}

export class AddTeamMemberDto {
  @IsUUID('7', { message: 'must be a valid user id' })
  userId!: string;
}

export class UpdateTeamMemberDto {
  @IsBoolean()
  assignmentEnabled!: boolean;
}
