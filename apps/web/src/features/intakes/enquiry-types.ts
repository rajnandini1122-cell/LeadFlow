import type { EnquiryType } from '@leadflow/api-types';

/**
 * The eight stored classifications, said in words.
 *
 * Shared between the detail panel and the queue filter so one enquiry cannot
 * read as "Sample request" in one place and "SAMPLE" in the other.
 *
 * A label is only ever a rendering of a value the API returned. Nothing here
 * invents a classification, and there is deliberately no fallback entry: the
 * `Record<EnquiryType, string>` type makes a new enum value a compile error
 * rather than a blank cell discovered by an operator.
 */
export const ENQUIRY_TYPE_LABELS: Record<EnquiryType, string> = {
  GENERAL: 'General enquiry',
  QUOTE: 'Quote request',
  SAMPLE: 'Sample request',
  BULK: 'Bulk order',
  EXPORT: 'Export',
  HORECA: 'HoReCa / institutional',
  DISTRIBUTOR: 'Distributor / dealer',
  PRIVATE_LABEL: 'Private label',
};
