import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LEAD_LIFECYCLE_FILTERS, LEAD_STATUSES } from '@leadflow/api-types';
import type { LeadLifecycleFilter, LeadStatus } from '@leadflow/api-types';

export class ListLeadsDto {
  @IsOptional()
  @IsIn(LEAD_STATUSES)
  status?: LeadStatus;

  @IsOptional()
  @IsUUID('7')
  assignedToId?: string;

  /**
   * Only leads nobody owns.
   *
   * An unassigned lead cannot have a follow-up row — `assigned_user_id` is NOT
   * NULL — so it appears in no follow-up queue at all. Without this filter a
   * manager could find those leads only by scanning the whole list for the
   * word "Unassigned", which is how they stayed unworked.
   */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  unassigned?: boolean;

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

  /**
   * Every lead from one CSV import.
   *
   * What makes a badly mapped run correctable: the screen that fixes it has to
   * be able to list exactly what that run created, and nothing else.
   */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid import batch id' })
  importBatchId?: string;

  /**
   * Which lifecycle states to list. Defaults to ACTIVE.
   *
   * The default is what keeps a deactivated lead out of the working pipeline
   * and out of every total computed through this filter. `INACTIVE` is the
   * explicit filter that makes those records reachable, and `ALL` exists for
   * the import-correction screen, which must show what it is about to act on
   * whatever state it is in.
   */
  @IsOptional()
  @IsIn(LEAD_LIFECYCLE_FILTERS, {
    message: `must be one of: ${LEAD_LIFECYCLE_FILTERS.join(', ')}`,
  })
  lifecycle?: LeadLifecycleFilter;

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
