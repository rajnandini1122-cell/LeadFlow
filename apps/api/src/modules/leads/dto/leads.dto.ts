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

  /** Narrows the list to one product, for the product drill-down. */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid product id' })
  productId?: string;

  /** Every opportunity for one customer. What Customer 360 links through to. */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid account id' })
  accountId?: string;

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
