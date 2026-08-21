/**
 * A small RFC 4180 CSV reader.
 *
 * Written rather than pulled in, because the job is narrow and the failure
 * modes of the naive `split(',')` version are exactly the ones real exports
 * hit: a company name containing a comma, an address spanning two lines, a
 * quoted field containing a quote. Those are data-loss bugs, not edge cases.
 */

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export class CsvParseError extends Error {}

/** Rows beyond this are refused outright rather than half-imported. */
export const MAX_ROWS = 5000;

export function parseCsv(input: string, maxRows = MAX_ROWS): ParsedCsv {
  // Excel writes a UTF-8 BOM; left in place it becomes part of the first
  // header name and every mapping against that column silently misses.
  const text = input.replace(/^﻿/, '');

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
    // Skip rows that are entirely empty — a trailing newline is not a record.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) {
      throw new CsvParseError(`File has more than ${maxRows} rows.`);
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

    switch (char) {
      case '"':
        if (sawField && field !== '') {
          throw new CsvParseError(`Unexpected quote on row ${rows.length + 1}.`);
        }
        inQuotes = true;
        sawField = true;
        break;
      case ',':
        endField();
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

  if (inQuotes) throw new CsvParseError('File ends inside a quoted value.');
  if (field !== '' || row.length > 0) endRow();

  const headers = rows.shift();
  if (!headers || headers.length === 0) throw new CsvParseError('File has no header row.');
  if (rows.length === 0) throw new CsvParseError('File has a header but no data rows.');

  return { headers: headers.map((header) => header.trim()), rows };
}

/** Lead fields a CSV column can be mapped onto. */
export const IMPORTABLE_FIELDS = [
  'firstName',
  'lastName',
  'mobile',
  'email',
  'companyName',
  'city',
  'source',
  'productInterest',
  'estimatedValue',
  'nextFollowUpAt',
] as const;

export type ImportableField = (typeof IMPORTABLE_FIELDS)[number];

export const REQUIRED_FIELDS: ImportableField[] = ['firstName', 'mobile'];

/** Header spellings seen in real exports, normalised for comparison. */
const ALIASES: Record<ImportableField, string[]> = {
  firstName: ['firstname', 'first', 'name', 'fullname', 'contactname', 'leadname', 'customername'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  mobile: [
    'mobile',
    'phone',
    'phonenumber',
    'phoneno',
    'mobilenumber',
    'mobileno',
    'contact',
    'contactnumber',
    'contactno',
    'cell',
    'whatsapp',
    'whatsappnumber',
  ],
  email: ['email', 'emailaddress', 'mail'],
  companyName: ['company', 'companyname', 'organisation', 'organization', 'business', 'firm'],
  city: ['city', 'town', 'location'],
  source: ['source', 'leadsource', 'channel', 'campaign'],
  productInterest: ['product', 'productinterest', 'interest', 'requirement', 'enquiryfor'],
  estimatedValue: ['value', 'estimatedvalue', 'amount', 'dealvalue', 'budget', 'price'],
  nextFollowUpAt: ['followup', 'nextfollowup', 'nextfollowupat', 'followupdate', 'duedate'],
};

const normalise = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A best-guess column mapping, offered to the user for confirmation.
 *
 * A guess, never a decision: the preview shows it and the import uses whatever
 * the user sends back. Importing on an unconfirmed guess is how a "budget"
 * column silently lands in "estimated value" for two thousand leads.
 */
export function suggestMapping(headers: string[]): Record<string, ImportableField> {
  const mapping: Record<string, ImportableField> = {};
  const taken = new Set<ImportableField>();

  for (const header of headers) {
    const key = normalise(header);
    if (!key) continue;

    const match = IMPORTABLE_FIELDS.find(
      (field) => !taken.has(field) && ALIASES[field].includes(key),
    );

    if (match) {
      mapping[header] = match;
      taken.add(match);
    }
  }

  return mapping;
}
