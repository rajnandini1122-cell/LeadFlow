/**
 * An RFC 4180 CSV reader, plus a writer for the error file.
 *
 * Written rather than pulled in, because the job is narrow and the failure
 * modes of the naive `split(',')` version are exactly the ones real exports
 * hit: a company name containing a comma, an address spanning two lines, a
 * quoted field containing a quote. Those are data-loss bugs, not edge cases.
 *
 * What it handles, each because a real file broke on it:
 *
 *   * a UTF-8 BOM, which Excel writes — left in place it becomes part of the
 *     first header name, so the first column (usually the name) is the one
 *     that never maps;
 *   * CRLF, LF and lone CR line endings;
 *   * quoted fields containing commas, quotes and newlines;
 *   * semicolon and tab delimiters, which Excel writes in locales where the
 *     comma is the decimal separator — a file like that previously parsed as
 *     ONE column per row and failed with "no column mapped to firstName",
 *     which told the user nothing about the real problem;
 *   * ragged rows, reported per row rather than silently padded.
 *
 * Unicode needs no special handling: JavaScript strings are UTF-16 throughout,
 * so Marathi, Devanagari and emoji survive by construction. There is a test
 * because "by construction" is a claim, not evidence.
 */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  /** Which delimiter was used, so the UI can say if it was not a comma. */
  delimiter: ',' | ';' | '\t';
}

export class CsvParseError extends Error {}

/** Rows beyond this are refused outright rather than half-imported. */
export const MAX_ROWS = 5000;

const DELIMITERS = [',', ';', '\t'] as const;
export type CsvDelimiter = (typeof DELIMITERS)[number];

/**
 * Which delimiter this file uses, decided on the HEADER LINE only.
 *
 * Counting over the whole file would be swayed by a free-text address column
 * full of commas in a semicolon-delimited file. The header line is short, is
 * written by the exporting tool rather than typed by a human, and is the line
 * whose field count has to be right for anything else to work.
 *
 * Quoted sections are skipped, so `"Smith, John";email` is not read as two
 * commas. Ties go to the comma, which is what the format is actually called.
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  let line = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === '\n' || char === '\r')) break;
    line += char;
  }

  const counts = DELIMITERS.map((delimiter) => ({
    delimiter,
    count: countOutsideQuotes(line, delimiter),
  }));

  const best = counts.reduce((winner, candidate) =>
    candidate.count > winner.count ? candidate : winner,
  );

  return best.count > 0 ? best.delimiter : ',';
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === delimiter) count += 1;
  }

  return count;
}

export function parseCsv(input: string, maxRows = MAX_ROWS): ParsedCsv {
  // Excel writes a UTF-8 BOM; left in place it becomes part of the first
  // header name and every mapping against that column silently misses.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = sniffDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawField = false;

  const endField = (): void => {
    row.push(field);
    field = '';
    sawField = false;
  };

  const endRow = (): void => {
    endField();
    // Skip rows that are entirely empty — a trailing newline is not a record,
    // and neither is the blank line Excel leaves between a table and a total.
    if (!row.every((value) => value.trim() === '')) rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) {
      throw new CsvParseError(
        `This file has more than ${maxRows} data rows. Split it and import the parts.`,
      );
    }
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === delimiter) {
      endField();
      continue;
    }

    switch (char) {
      case '"':
        if (sawField && field !== '') {
          throw new CsvParseError(
            `Row ${rows.length + 1} has a quote in the middle of a value. ` +
              'A value containing a quote must be wrapped in quotes, with each inner quote doubled.',
          );
        }
        inQuotes = true;
        sawField = true;
        break;
      case '\r':
        // Handled by the \n that follows; a lone \r is treated as a row end.
        if (text[i + 1] !== '\n') endRow();
        break;
      case '\n':
        endRow();
        break;
      default:
        field += char;
        sawField = true;
    }
  }

  if (inQuotes) {
    throw new CsvParseError(
      'The file ends inside a quoted value. A quote was opened and never closed.',
    );
  }
  if (field !== '' || row.length > 0) endRow();

  const headers = rows.shift();
  if (!headers || headers.length === 0) throw new CsvParseError('The file has no header row.');
  if (rows.length === 0) {
    throw new CsvParseError('The file has a header row but no data rows below it.');
  }

  /*
   * Headers trimmed, and a BOM stripped a second time.
   *
   * The slice above removes a BOM at position 0 of the file. A file assembled
   * by concatenation can carry one at the start of a later line, and a header
   * beginning with an invisible character matches nothing — which looks exactly
   * like a missing column.
   */
  return {
    headers: headers.map((header) => header.replace(/\uFEFF/g, '').trim()),
    rows,
    delimiter,
  };
}

/**
 * CSV text from rows, for the downloadable error file.
 *
 * Quotes a value whenever it contains a delimiter, a quote or a newline, which
 * is the minimum RFC 4180 requires. A leading `=`, `+`, `-` or `@` is also
 * quoted AND prefixed with a single quote: Excel and Sheets treat such a cell
 * as a formula, and a value like `=cmd|...` in a file a user is told to open is
 * the CSV injection path. The file we hand back must be safe to double-click.
 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(escapeCsvValue).join(',')];

  for (const row of rows) {
    lines.push(row.map((value) => escapeCsvValue(value ?? '')).join(','));
  }

  // CRLF, which is what RFC 4180 specifies and what Excel expects.
  return `${lines.join('\r\n')}\r\n`;
}

function escapeCsvValue(value: string | number): string {
  const text = String(value);
  const dangerous = /^[=+\-@\t\r]/.test(text);
  const body = dangerous ? `'${text}` : text;

  return /["\n\r,;\t]/.test(body) || dangerous ? `"${body.replace(/"/g, '""')}"` : body;
}
