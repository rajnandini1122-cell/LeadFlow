/**
 * One name field, split into the two columns the CRM stores.
 *
 * A STORAGE AND DISPLAY SPLIT, and nothing more. It is not an interpretation of
 * anybody's legal name, it does not claim to know which part is a family name,
 * and it must not be read as doing either. A website form asks for "name"
 * because that is the only question with a universally correct answer; the CRM
 * has `first_name` and `last_name` because it was built that way, and something
 * has to bridge the two without pretending to understand more than it does.
 *
 * What it deliberately does NOT do:
 *
 *   it does not reorder. Names are stored in the order the person wrote them,
 *   whatever convention that follows. Detecting "family name first" would mean
 *   guessing a culture from a string, and being wrong about somebody's own name
 *   is not a small error;
 *
 *   it does not infer titles, honorifics or gender. "Dr" stays part of the
 *   name rather than being stripped into a field nobody asked for;
 *
 *   it does not require two parts. A single-word name is a whole name — for a
 *   great many people it is the only name — and it goes in `firstName` with
 *   `lastName` left empty rather than being padded or duplicated.
 *
 * Everything after the first whitespace-delimited word becomes the last name,
 * so "Ana Maria Ferreira da Silva" keeps four of its five words together rather
 * than losing three. That is the choice that preserves the most text; it is not
 * a claim that "Maria Ferreira da Silva" is a surname.
 */

/** The CRM's column widths. Both `VarChar(80)`. */
const MAX_LENGTH = 80;

export interface PersonName {
  firstName: string;
  /** Undefined for a single-word name — absent rather than empty. */
  lastName?: string | undefined;
}

/**
 * Splits a full name, or returns undefined when there is nothing usable.
 *
 * Undefined rather than a placeholder: a caller has to decide what an enquiry
 * with no name means, and inventing "Unknown" here would put that word in front
 * of a salesperson as though the customer had typed it.
 */
export function splitPersonName(raw: string | null | undefined): PersonName | undefined {
  const collapsed = raw?.trim().replace(/\s+/g, ' ');
  if (!collapsed) return undefined;

  const separator = collapsed.indexOf(' ');

  if (separator === -1) {
    // One word is a whole name. Padding it, or copying it into both columns,
    // would put a surname on somebody who did not give one.
    return { firstName: truncate(collapsed) };
  }

  const first = collapsed.slice(0, separator);
  const rest = collapsed.slice(separator + 1);

  return { firstName: truncate(first), lastName: truncate(rest) };
}

/**
 * Fits a part to the column.
 *
 * Truncation loses information, which is why it is the last resort rather than
 * the first: the collapse above removes only the whitespace nobody meant. An 80
 * character single name is far outside ordinary use, and storing a shortened
 * version beats refusing the enquiry.
 */
function truncate(part: string): string {
  return part.length <= MAX_LENGTH ? part : part.slice(0, MAX_LENGTH).trimEnd();
}
