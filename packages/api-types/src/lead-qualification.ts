/**
 * Two-level lead qualification: ROUGH -> REFINED.
 *
 * A QUALIFICATION, not a sales stage. It sits beside `LeadStatus` and never
 * replaces it: a lead is Rough or Refined AND New / Contacted / ... / Won.
 *
 *   ROUGH    -- just arrived (form, import, website, WhatsApp). Can be edited,
 *               assigned, researched and contacted to qualify it, with notes.
 *               Kept OUT of routine sales follow-up queues, overdue counts,
 *               quotations and later sales stages.
 *   REFINED  -- an authorised person verified the company, a relevant contact
 *               and the business fit. Enters the normal sales workflow.
 *
 * Shared by the API, the web app and the Android app (the same web bundle).
 */

export const LEAD_QUALIFICATIONS = ['ROUGH', 'REFINED'] as const;
export type LeadQualification = (typeof LEAD_QUALIFICATIONS)[number];

/** Sales stages a ROUGH lead may be in. Anything else needs it refined first. */
export const ROUGH_ALLOWED_STATUSES = ['NEW', 'CONTACTED', 'LOST'] as const;

/** What a qualification note says happened. Recorded on the timeline only. */
export const QUALIFICATION_NOTE_OUTCOMES = {
  RESEARCHED: 'Researched the company',
  CONTACTED_INTERESTED: 'Spoke to them — interested',
  CONTACTED_CALL_BACK: 'Spoke to them — call back',
  NOT_REACHABLE: 'Could not reach them',
  WRONG_CONTACT: 'Wrong person or number',
  NOT_A_FIT: 'Not a fit for us',
} as const;
export type QualificationNoteOutcome = keyof typeof QUALIFICATION_NOTE_OUTCOMES;

/** Why a lead was refined. Stored on the lead. */
export const REFINEMENT_OUTCOMES = {
  GENUINE_REQUIREMENT: 'Genuine requirement confirmed',
  REPEAT_CUSTOMER: 'Existing or repeat customer',
  TRADER_OR_DISTRIBUTOR: 'Trader or distributor',
  IMPORTER_OR_EXPORTER: 'Importer or exporter',
  OTHER: 'Other (see note)',
} as const;
export type RefinementOutcome = keyof typeof REFINEMENT_OUTCOMES;

/**
 * What every pre-existing lead was given by the migration: they were already
 * being worked as sales leads, so they were not reset to Rough.
 */
export const EXISTING_LEAD_REFINEMENT = 'EXISTING_LEAD';
