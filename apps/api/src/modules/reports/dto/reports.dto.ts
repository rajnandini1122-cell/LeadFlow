import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { RANGE_PRESETS, type RangePreset } from '../date-range';

/**
 * Range selection.
 *
 * Deliberately carries no scope or owner parameter: how much of the pipeline a
 * caller may see is derived from their permissions server-side, and a query
 * string that could widen it would make the permission decorative.
 */
export class ReportRangeDto {
  @IsOptional()
  @IsIn(RANGE_PRESETS, {
    message: `must be one of: ${RANGE_PRESETS.join(', ')}`,
  })
  preset?: RangePreset;

  /** Inclusive start of a custom range, YYYY-MM-DD in the org's timezone. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  from?: string;

  /** Inclusive end of a custom range. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  to?: string;
}

export class DailyReportDto {
  /** Defaults to today in the organization's timezone. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  date?: string;
}
