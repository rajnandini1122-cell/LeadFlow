import { Transform } from 'class-transformer';
import { IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Taking a lead out of the live pipeline.
 *
 * A REASON IS REQUIRED, and the minimum length is deliberate. "x" satisfies a
 * presence check and tells the next person nothing; the point of the field is
 * that somebody opening the record in six months can see why it is not live.
 * The database enforces non-emptiness as well, because a rule kept only in a
 * DTO goes missing the first time anything writes through another path.
 */
export class DeactivateLeadDto {
  @IsString()
  @MinLength(3, { message: 'must say why — at least a few words' })
  @MaxLength(255)
  @Transform(trim)
  reason!: string;
}

/**
 * Putting a lead back.
 *
 * The reason is OPTIONAL here, unlike deactivation. Reactivating is restoring
 * the normal state of things, and the deactivation reason already records what
 * the exception was; demanding a second justification to undo a mistake is the
 * kind of friction that gets worked around.
 */
export class ReactivateLeadDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Transform(trim)
  reason?: string;

  /**
   * Required unless the lead is WON or LOST, which the service checks.
   *
   * `leads_active_requires_followup` forbids an active lead with nothing to do,
   * so a lead cannot come back into the pipeline without a next action. The
   * caller supplies the date rather than the server inventing one: whoever is
   * reactivating knows when they mean to act, and a server-chosen date is a
   * reminder nobody agreed to.
   */
  @IsOptional()
  @IsISO8601({}, { message: 'must be an ISO 8601 date' })
  nextFollowUpAt?: string;
}
