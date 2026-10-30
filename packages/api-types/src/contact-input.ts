/**
 * Cleans contact details typed or PASTED into a form, before they are validated.
 *
 * Shared by the API (DTO transforms) and the web forms, so what a salesperson
 * sees after saving is exactly what was stored.
 *
 * Found in production on 2026-10-30: an address copied from a business card or
 * website arrives with things nobody can see or would think to delete —
 *   * a trailing full stop or comma ("sales@example.com.");
 *   * a `mailto:` prefix from a copied link;
 *   * a full-width ＠ or ． from some phone keyboards;
 *   * zero-width spaces, direction marks, no-break spaces and BOMs, which the
 *     validator either rejects ("must be a valid email address" on an address
 *     that looks right) or — worse — ACCEPTS, storing an address that looks
 *     right and never delivers.
 * None of those is a decision the salesperson made, so none should block them.
 * Anything still wrong after this (a space inside, two addresses in one box)
 * is genuinely wrong and is left for the validator to report.
 */

/** Invisible formatting characters (Unicode category Cf) and no-break / odd spaces. */
const INVISIBLE = /[\p{Cf}  -   　]/gu;

/** Text cleaned of invisible characters and full-width forms, trimmed. Empty → ''. */
export function cleanText(value: string): string {
  return value.normalize('NFKC').replace(INVISIBLE, '').trim();
}

/**
 * An email address as it should be stored: cleaned, `mailto:` and trailing
 * punctuation removed, lower-cased. Returns '' for nothing.
 */
export function cleanEmail(value: string): string {
  return cleanText(value)
    .replace(/^mailto:/i, '')
    .replace(/[.,;:]+$/, '')
    .toLowerCase();
}

/**
 * A list of extra emails or phones: each cleaned, blanks dropped, duplicates
 * (after cleaning) removed, order kept.
 */
export function cleanList(values: readonly string[], clean: (value: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = clean(raw);
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** How many extra phone numbers / emails a lead can hold. */
export const MAX_ADDITIONAL_CONTACTS = 5;
