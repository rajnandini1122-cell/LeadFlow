import { HttpStatus } from '@nestjs/common';
import {
  ERROR_CODES,
  ROUGH_ALLOWED_STATUSES,
  type LeadQualification,
  type LeadStatus,
} from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';

/**
 * The server-side rules for ROUGH leads (see packages/api-types
 * lead-qualification.ts). Enforced here so no client -- web, the Android app
 * or an older APK still installed on a phone -- can route around them.
 */

/** A Rough lead may only be New, Contacted or Lost. Anything further needs it refined. */
export function assertStatusAllowed(
  qualification: LeadQualification | string,
  status: LeadStatus,
): void {
  if (qualification !== 'ROUGH') return;
  if ((ROUGH_ALLOWED_STATUSES as readonly string[]).includes(status)) return;
  throw notRefined('move it to this stage');
}

/** Sales follow-ups and call outcomes are for Refined leads. */
export function assertRefined(qualification: LeadQualification | string, action: string): void {
  if (qualification === 'ROUGH') throw notRefined(action);
}

function notRefined(action: string): AppException {
  return new AppException(
    ERROR_CODES.LEAD_NOT_REFINED,
    `This lead is still Rough. Mark it as Refined before you ${action}. ` +
      'You can still edit it, assign it and record qualification notes.',
    HttpStatus.CONFLICT,
  );
}
