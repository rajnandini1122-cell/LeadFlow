import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { LEAD_STATUSES, type LeadStatus } from '@leadflow/api-types';

export class ListLeadsDto {
  @IsOptional()
  @IsIn(LEAD_STATUSES)
  status?: LeadStatus;

  @IsOptional()
  @IsUUID('7')
  assignedToId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsUUID('7')
  cursor?: string;

  /** Capped so a client cannot request an unbounded page. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
