import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  LEAD_BULK_LIMIT,
  LEAD_PRIORITIES,
  LEAD_STATUSES,
  type LeadPriority,
  type LeadStatus,
} from '@leadflow/api-types';
import { ListLeadsDto } from './leads.dto';

/**
 * Which leads: explicit ids (rows the person ticked), or "everything matching
 * these list filters" resolved on the server with the caller's own visibility.
 */
export class LeadSelectionDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LEAD_BULK_LIMIT)
  @IsUUID('7', { each: true })
  ids?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ListLeadsDto)
  query?: ListLeadsDto;

  /** With `query`: ticked-off rows to leave out. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LEAD_BULK_LIMIT)
  @IsUUID('7', { each: true })
  excludeIds?: string[];

  /**
   * When the person looked at the list. A lead changed after this is skipped as
   * a CONFLICT rather than overwritten (optimistic concurrency).
   */
  @IsDateString()
  snapshotAt!: string;
}

class BulkBaseDto {
  @ValidateNested()
  @Type(() => LeadSelectionDto)
  selection!: LeadSelectionDto;

  /** Preview only: nothing is written. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class BulkUpdateLeadsDto extends BulkBaseDto {
  @IsIn(['SET_STATUS', 'SET_PRIORITY', 'SCHEDULE_FOLLOW_UP'])
  action!: 'SET_STATUS' | 'SET_PRIORITY' | 'SCHEDULE_FOLLOW_UP';

  @IsOptional()
  @IsIn(LEAD_STATUSES)
  status?: LeadStatus;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  lostReason?: string;

  @IsOptional()
  @IsIn(LEAD_PRIORITIES)
  priority?: LeadPriority;

  @IsOptional()
  @IsDateString()
  nextFollowUpAt?: string;
}

export class BulkAssignLeadsDto extends BulkBaseDto {
  @IsUUID('7')
  assignedToId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
