import { Type } from 'class-transformer';
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

export const OFFBOARD_ACTIONS = ['DEACTIVATE', 'REMOVE'] as const;
export type OffboardAction = (typeof OFFBOARD_ACTIONS)[number];

export class OffboardMemberDto {
  /**
   * DEACTIVATE keeps the membership row and the person's name on old activity;
   * REMOVE also takes them off the roster. Neither hard-deletes anything.
   */
  @IsIn(OFFBOARD_ACTIONS, { message: `must be one of: ${OFFBOARD_ACTIONS.join(', ')}` })
  action!: OffboardAction;

  /**
   * Who takes the work over.
   *
   * Optional only because a member with nothing assigned needs no successor.
   * When there IS active work the API refuses without one, rather than letting
   * it be orphaned.
   */
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid user id' })
  reassignToId?: string;

  /**
   * Also move WON, LOST and archived leads.
   *
   * Off by default. Who closed a deal is a fact about the past, and rewriting
   * it would corrupt every commission and performance report already run.
   */
  @IsOptional()
  @IsBoolean()
  includeHistorical?: boolean;

  /** Recorded on each moved lead's timeline. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class LeaveOrganizationDto {
  @IsOptional()
  @IsUUID('7', { message: 'must be a valid user id' })
  reassignToId?: string;

  @IsOptional()
  @IsBoolean()
  includeHistorical?: boolean;
}

export class TransferAdminDto {
  /** Must be an ACTIVE member of the caller's own organization. */
  @IsUUID('7', { message: 'must be a valid user id' })
  toUserId!: string;

  /**
   * Whether the caller gives up ownership.
   *
   * `false` simply adds a second owner, which is the safer default for a team
   * that wants shared responsibility rather than a handover.
   */
  @IsOptional()
  @IsBoolean()
  stepDown?: boolean;
}

export class AuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsUUID('7')
  cursor?: string;
}
