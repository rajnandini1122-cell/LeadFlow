import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { LEAD_STATUSES, type LeadStatus } from '@leadflow/api-types';

/**
 * Filters for the control plane's lead read.
 *
 * A SMALL, CLOSED set, and smaller than the CRM's own. The control plane is not
 * a second CRM: it exists so an export operation can find the enquiries it has
 * to act on, which means "which stage", "whose", "which customer" and "when".
 *
 * Deliberately absent, and each for a reason:
 *
 *   `search`  a free-text search over names, companies, numbers and addresses
 *             would turn a signed backend integration into a way to look up a
 *             tenant's customers by phone number, outside every CRM permission.
 *   `lifecycle`  there is no way to ask for deactivated leads. A record somebody
 *             took out of service is not work to hand off, and the one caller
 *             that needs to see them is the CRM screen that corrects imports.
 *   `importBatchId`  correcting a bad import is a CRM operation, not a control
 *             plane one.
 */
export class AdminLeadQueryDto {
  /**
   * The pipeline stage. `QUALIFIED` is the one this endpoint was asked for: it
   * is the earliest state carrying human judgement that still occurs before an
   * order exists, which is what a sample-first export flow needs.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsIn(LEAD_STATUSES, { message: `must be one of: ${LEAD_STATUSES.join(', ')}` })
  status?: LeadStatus;

  @IsOptional()
  @IsUUID('7', { message: 'must be a valid user id' })
  assignedToId?: string;

  @IsOptional()
  @IsUUID('7', { message: 'must be a valid account id' })
  accountId?: string;

  /** Inclusive lower bound on creation time. */
  @IsOptional()
  @IsISO8601({}, { message: 'must be an ISO 8601 instant' })
  createdFrom?: string;

  /** Exclusive upper bound, so a whole day is [midnight, next midnight). */
  @IsOptional()
  @IsISO8601({}, { message: 'must be an ISO 8601 instant' })
  createdTo?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  offset?: number;
}
