import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { INTAKE_STATUSES } from '@leadflow/api-types';

/**
 * The body of a retry: nothing at all.
 *
 * A class with no properties rather than no DTO, and the difference is the
 * whole point. Without a class the global pipe has nothing to validate against
 * and quietly accepts whatever is sent; with one, every supplied property is
 * non-whitelisted and `forbidNonWhitelisted` refuses the request.
 *
 * So an attempt to retry an enquiry with a rewritten name or message is a 400
 * rather than a field silently dropped — because a caller whose edit vanishes
 * without comment is a caller who tries again.
 */
export class RetryIntakeDto {}

/**
 * Filters for the intake queue.
 *
 * Deliberately a small, closed set. An operations queue is filtered by "what
 * state is it in", "where did it come from" and "when" — not by the customer's
 * details, which would turn an operations tool into a way to search people by
 * phone number without going through the CRM's own permissions.
 */
export class IntakeQueryDto {
  @IsOptional()
  @IsIn(INTAKE_STATUSES, { message: `must be one of: ${INTAKE_STATUSES.join(', ')}` })
  status?: (typeof INTAKE_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  source?: string;

  /** Inclusive. */
  @IsOptional()
  @IsISO8601({}, { message: 'must be an ISO 8601 instant' })
  receivedFrom?: string;

  /** Exclusive, so a whole day is [midnight, next midnight). */
  @IsOptional()
  @IsISO8601({}, { message: 'must be an ISO 8601 instant' })
  receivedTo?: string;

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
