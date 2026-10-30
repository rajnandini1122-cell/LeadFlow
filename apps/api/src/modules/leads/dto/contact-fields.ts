import { cleanEmail, cleanList, cleanText } from '@leadflow/api-types';

/*
 * class-transformer `@Transform` functions for a lead's contact details.
 *
 * They run BEFORE validation, so pasted junk a person cannot see (see
 * packages/api-types/src/contact-input.ts) never reaches the validator, and
 * what is stored is exactly what was meant.
 *
 * `null` passes through untouched everywhere: on an edit it means "clear this".
 */
type TransformArgs = { value: unknown };

/** Create: blank means "not given". */
export const optionalText = ({ value }: TransformArgs): unknown => {
  if (typeof value !== 'string') return value;
  const cleaned = cleanText(value);
  return cleaned === '' ? undefined : cleaned;
};

/** Edit: blank means "clear it". */
export const clearableText = ({ value }: TransformArgs): unknown => {
  if (typeof value !== 'string') return value;
  const cleaned = cleanText(value);
  return cleaned === '' ? null : cleaned;
};

/** An email address: cleaned and lower-cased; blank means "not given". */
export const optionalEmail = ({ value }: TransformArgs): unknown => {
  if (typeof value !== 'string') return value;
  const cleaned = cleanEmail(value);
  return cleaned === '' ? undefined : cleaned;
};

/** Extra phone numbers: cleaned text (canonicalised to E.164 by the service), blanks and repeats dropped. */
export const phoneList = ({ value }: TransformArgs): unknown =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? cleanList(value as string[], cleanText)
    : value;

/** Extra email addresses: cleaned, blanks and repeats dropped. */
export const emailList = ({ value }: TransformArgs): unknown =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? cleanList(value as string[], cleanEmail)
    : value;
