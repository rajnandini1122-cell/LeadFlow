import {
  IMPORTABLE_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  type ImportableField,
} from '@leadflow/api-types';
import { isValidCountry } from '../../../common/utils/locale';
import { PhoneParseError, toE164 } from '../../../common/utils/phone';

/**
 * Turning one CSV row into lead field values, and saying what is wrong with it.
 *
 * Separated from the service so the rules can be unit-tested against strings
 * without a database, and so the preview and the import share ONE definition of
 * "valid". They previously shared a function but called it with different
 * arguments — `preview` passed `missingRequired`, `import` passed `[]` — so a
 * row could be reported valid by one and rejected by the other.
 */

export type RowValues = Partial<Record<ImportableField, string>>;

/**
 * Reads the mapped columns out of one row.
 *
 * BY INDEX, not by header name, which is what makes duplicate headers
 * survivable: two columns called "Phone" are two different indexes even though
 * a `Record<header, field>` can only name one of them. The caller is warned
 * about the duplication separately.
 *
 * Empty and whitespace-only cells become absent rather than empty strings, so
 * `""` in a CSV does not overwrite anything with a blank.
 */
export function readRow(
  headers: string[],
  row: string[],
  mapping: Record<string, ImportableField>,
): RowValues {
  const values: RowValues = {};

  for (const [index, header] of headers.entries()) {
    const field = mapping[header];
    if (!field || !IMPORTABLE_FIELDS.includes(field)) continue;
    // First mapped column for a field wins; a second is reported as a
    // collision rather than silently overwriting the first.
    if (values[field] !== undefined) continue;

    const raw = (row[index] ?? '').trim();
    if (raw !== '') values[field] = raw;
  }

  return values;
}

export interface RowValidationContext {
  /** The tenant's dialling country, for parsing a national phone number. */
  country: string;
  /** Applied to rows whose own follow-up cell is empty. */
  defaultNextFollowUpAt: string | undefined;
  /** Fields no column was mapped to. Reported once per row, as a row error. */
  missingRequired: readonly ImportableField[];
  /** How many columns the header row declared. */
  headerCount: number;
  /** This row's own column count, for the ragged-row check. */
  columnCount: number;
}

/**
 * Everything wrong with one row, in words a person can act on.
 *
 * Every message names the FIELD and what would fix it. The old version
 * produced `mobile is not a valid phone number`, which is true and useless when
 * the real problem is that the file is semicolon-delimited and the whole row
 * landed in one cell. These say which value was rejected.
 */
export function validateRow(values: RowValues, context: RowValidationContext): string[] {
  const errors: string[] = [];

  for (const field of context.missingRequired) {
    errors.push(`No column is mapped to ${field}, which is required.`);
  }

  /*
   * A ragged row is reported BEFORE the field checks.
   *
   * More cells than headers almost always means an unquoted comma inside a
   * value, which shifts every later column by one — so the name lands in the
   * company field and the phone number in the city. Saying "mobile is not a
   * valid phone number" for that row sends the user looking in the wrong place.
   */
  if (context.columnCount > context.headerCount) {
    errors.push(
      `This row has ${context.columnCount} values but the header has ${context.headerCount} columns. ` +
        'A value probably contains a comma and needs wrapping in quotes.',
    );
  }

  for (const field of REQUIRED_IMPORT_FIELDS) {
    if (!context.missingRequired.includes(field) && !values[field]) {
      errors.push(`${field} is empty.`);
    }
  }

  if (values.mobile && !safeE164(values.mobile, context.country)) {
    errors.push(
      `"${values.mobile}" is not a phone number we can read. ` +
        'Use digits, optionally with a + and country code.',
    );
  }

  if (values.email && !isPlausibleEmail(values.email)) {
    errors.push(`"${values.email}" is not a valid email address.`);
  }

  if (values.estimatedValue && parseAmount(values.estimatedValue) === null) {
    errors.push(`"${values.estimatedValue}" is not a number.`);
  }

  /*
   * A two-letter ISO country, checked against the runtime's own ICU data
   * rather than a list in source.
   *
   * "India" is rejected with a message saying so, instead of being truncated
   * to "In" and stored — a silent truncation is how a country filter ends up
   * with four spellings of one country.
   */
  if (values.country && !isValidCountry(values.country.toUpperCase())) {
    errors.push(
      `"${values.country}" is not a two-letter country code. Use IN for India, AE for the UAE.`,
    );
  }

  // Length limits mirror the columns exactly, so a long value is reported here
  // instead of arriving as a database error partway through the file.
  for (const [field, limit] of Object.entries(MAX_LENGTHS) as [ImportableField, number][]) {
    const value = values[field];
    if (value && value.length > limit) {
      errors.push(`${field} is ${value.length} characters; the limit is ${limit}.`);
    }
  }

  // "No lead left behind" is a database CHECK constraint: an active lead with
  // no next action cannot be stored at all. Catching it here turns a 500 from
  // Postgres into a row the user can fix.
  const followUp = values.nextFollowUpAt ?? context.defaultNextFollowUpAt;
  if (!followUp) {
    errors.push('No follow-up date in this row, and no default was set for the import.');
  } else if (parseDate(followUp) === null) {
    errors.push(
      `"${followUp}" is not a date we can read. Use YYYY-MM-DD, or DD/MM/YYYY.`,
    );
  }

  return errors;
}

/** Mirrors the column widths in schema.prisma. */
const MAX_LENGTHS: Partial<Record<ImportableField, number>> = {
  firstName: 80,
  lastName: 80,
  companyName: 200,
  email: 320,
  addressLine1: 200,
  addressLine2: 200,
  city: 80,
  state: 80,
  postalCode: 20,
  source: 60,
  productInterest: 200,
};

/**
 * Deliberately a plausibility check, not RFC 5322.
 *
 * A fully correct email regex is famously enormous and still accepts addresses
 * no mail server would, and the cost of being strict here is refusing a real
 * customer's real address. This rejects what is obviously not an address and
 * lets the rest through.
 */
export function isPlausibleEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && !value.includes('..');
}

/**
 * A number from a spreadsheet cell.
 *
 * Thousands separators and a currency symbol are stripped, because
 * `"₹ 2,50,000"` is what a real Indian export writes and `Number()` returns
 * NaN for it — so the row was rejected with "is not a number" for a value that
 * plainly is one. Indian lakh grouping (2,50,000) works for free: every comma
 * goes, wherever it sits.
 *
 * A trailing or leading `-` is kept, so a negative is read and then refused by
 * the caller rather than silently becoming positive.
 */
export function parseAmount(value: string): number | null {
  // Separators first: spaces, ordinary commas and non-breaking spaces, which
  // is what a copy out of a browser leaves behind.
  const withoutSeparators = value.replace(/[\s,\u00A0]/g, '');

  // Then any currency word or symbol in front: "Rs.", "INR", a rupee or dollar
  // sign. The dot is deliberately NOT in this class, so "Rs." leaves one.
  const prefix = /^[^\d+.-]+/.exec(withoutSeparators)?.[0] ?? '';
  let cleaned = withoutSeparators.slice(prefix.length);

  /*
   * A dot left behind by that prefix is punctuation, not a decimal point.
   *
   * "Rs.250000" becomes ".250000" once "Rs" is removed, and `Number(".250000")`
   * is 0.25 \u2014 a value a thousand times too small, with no error anywhere.
   *
   * Dropped ONLY when a prefix was actually stripped, so a bare ".5" still
   * means 0.5 rather than being silently multiplied by ten.
   */
  if (prefix !== '' && cleaned.startsWith('.')) cleaned = cleaned.replace(/^\.+/, '');

  if (cleaned === '' || !/^[+-]?\d*\.?\d+$/.test(cleaned)) return null;

  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A date from a spreadsheet cell.
 *
 * ISO first, then DD/MM/YYYY and DD-MM-YYYY, which is what an Indian or
 * European export writes.
 *
 * `new Date("01/02/2026")` is read as US month-first by every JavaScript
 * runtime, so a file saying 1 February would silently import as 2 January. Any
 * file written for this product's users is day-first, so day-first is what the
 * explicit branch below assumes — and a value whose day exceeds 12 proves the
 * convention rather than guessing at it.
 */
export function parseDate(value: string): Date | null {
  const trimmed = value.trim();

  // ISO 8601, with or without a time.
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const dayFirst = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(trimmed);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = Number(dayFirst[2]);
    const year = Number(dayFirst[3]);

    if (day < 1 || day > 31 || month < 1 || month > 12) return null;

    // UTC, so the stored instant does not shift by a day depending on where the
    // server happens to be.
    const parsed = new Date(Date.UTC(year, month - 1, day));

    // Rejects 31/02: the constructor rolls it over to 3 March rather than
    // failing, so the result is checked against what went in.
    return parsed.getUTCDate() === day && parsed.getUTCMonth() === month - 1 ? parsed : null;
  }

  return null;
}

export function safeE164(input: string | undefined, country: string): string | null {
  if (!input) return null;
  try {
    return toE164(input, country);
  } catch (error) {
    if (error instanceof PhoneParseError) return null;
    throw error;
  }
}
