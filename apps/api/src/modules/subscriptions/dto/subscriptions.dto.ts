import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { BILLING_INTERVALS, type BillingInterval } from '@leadflow/api-types';

/**
 * What an organization may change about its own subscription.
 *
 * `status` is deliberately absent. A client asserting "I am ACTIVE" would be
 * asserting that it has paid, which only a payment provider can know. Because
 * the global ValidationPipe runs with `forbidNonWhitelisted`, sending one is a
 * 400 rather than a silently ignored field.
 */
export class ChangePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  planCode?: string;

  @IsOptional()
  @IsIn(BILLING_INTERVALS, { message: `must be one of: ${BILLING_INTERVALS.join(', ')}` })
  billingInterval?: BillingInterval;
}
