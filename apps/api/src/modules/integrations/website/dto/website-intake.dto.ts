import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsCountryCode } from '../../../../common/validation/locale.validators';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * What the website may submit.
 *
 * Every field is optional except the message, because a real enquiry form is
 * allowed to ask for very little — a phone number and "call me" is a lead, and
 * refusing it would lose a customer to protect a schema.
 *
 * Two things are deliberately NOT here:
 *
 *   organizationId — the tenant comes from configuration. A caller that could
 *   name its own would be able to write into any tenant with one valid
 *   signature, since a signature proves who is calling and not what they may
 *   touch.
 *
 *   externalEventId — the idempotency key travels in a SIGNED header. In the
 *   body it would be covered by the signature too, but it would also be two
 *   places one value can live, and the first time they disagreed the question
 *   would be which one decided.
 *
 * Unknown properties are refused outright by the global pipe rather than
 * ignored, so a website sending a field this version does not understand finds
 * out at once instead of watching it vanish.
 */
export class WebsiteIntakeDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsEmail({}, { message: 'must be a valid email address' })
  @MaxLength(320)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email?: string;

  /**
   * As the visitor typed it.
   *
   * Canonicalised to E.164 by the service, using the same parser the CRM uses,
   * against the country below when one is given. Not validated here: a number
   * that cannot be parsed must not lose the enquiry, and what happens to it is
   * a decision for the service, not for a decorator.
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Transform(trim)
  phone?: string;

  /** ISO 3166-1 alpha-2. Also the dialling region for the number above. */
  @IsOptional()
  @IsString()
  @MaxLength(2)
  @IsCountryCode()
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  company?: string;

  @IsString()
  @MinLength(2, { message: 'must say something' })
  @MaxLength(4000)
  @Transform(trim)
  message!: string;

  /** What they asked about. Matched to the product catalogue by a later phase. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  productInterest?: string;

  /** The page or campaign the enquiry came from, for attribution. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  sourcePage?: string;
}
