import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class UpdateOrganizationSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  followupReminderMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  followupOverdueMinutes?: number;

  @IsOptional()
  @IsBoolean()
  escalateToManager?: boolean;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:MM in 24-hour form' })
  workingHoursStart?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:MM in 24-hour form' })
  workingHoursEnd?: string;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  /**
   * IANA zone name. Validated against the runtime's own tz database rather
   * than a hand-maintained list, so it cannot drift.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]+\/[A-Za-z_+-]+$/, { message: 'must be an IANA timezone, e.g. Asia/Kolkata' })
  timezone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateOrganizationSettingsDto)
  settings?: UpdateOrganizationSettingsDto;
}
