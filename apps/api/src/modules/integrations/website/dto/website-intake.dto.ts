import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ENQUIRY_TYPES, type EnquiryType } from '@leadflow/api-types';
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

  // --- what the customer wants -----------------------------------------------

  /**
   * How the visitor classified their own enquiry.
   *
   * A closed set, uppercased before validation so a form posting `sample` is
   * accepted and stored as `SAMPLE` — the website should not have to know our
   * casing. An unrecognised value is REFUSED rather than coerced to GENERAL:
   * silently reclassifying somebody's enquiry is worse than telling the website
   * its value is wrong.
   *
   * Never written to `source`, which stays `WEBSITE`, and never written to
   * `productInterest`, which is what the customer typed.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsIn(ENQUIRY_TYPES, {
    message: `must be one of: ${ENQUIRY_TYPES.join(', ')}`,
  })
  enquiryType?: EnquiryType;

  /**
   * Sub-national region, as the visitor supplied it.
   *
   * Reaches territory resolution, which already understands STATE coverage.
   * Nothing infers it — an absent state stays absent.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  state?: string;

  /** City or town, as supplied. Also reaches territory resolution. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  city?: string;

  /**
   * How much they want, in their own words — "500 kg", "2 tonnes", "a pallet".
   *
   * Free text deliberately. A number would need a unit beside it and a parser
   * between them, and a parser guessing that "2" means tonnes is how a quote
   * comes out a thousand times wrong.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(trim)
  quantity?: string;

  /**
   * Where an export enquiry wants goods delivered. ISO 3166-1 alpha-2.
   *
   * Distinct from `country`, which is where the ENQUIRER is. An Indian buying
   * office shipping to Oman is `country=IN`, `destinationCountry=OM`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2)
  @IsCountryCode()
  destinationCountry?: string;

  /**
   * Whether they asked for a sample.
   *
   * Optional, and absent is not `false`: a form that never asked has no answer,
   * and recording a decline nobody made would mislead whoever reads it.
   */
  @IsOptional()
  @IsBoolean()
  sampleRequired?: boolean;
}
