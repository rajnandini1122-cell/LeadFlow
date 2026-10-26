import {
  IMPORTABLE_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  type ImportableField,
  type MappingCollision,
  type SuggestedColumn,
} from '@leadflow/api-types';

/**
 * Matching CSV column headers to lead fields.
 *
 * THE DEFECTS THIS FILE FIXES, all four from one cause — the old matcher was a
 * single `ALIASES[field].includes(normalised)` lookup, and everything it could
 * not answer it answered with silence:
 *
 *   1. NO ADDRESS. There were no aliases for street, state, postal code or
 *      country, because the columns did not exist. An "Address Line 1" column
 *      matched nothing and vanished without comment.
 *
 *   2. FIRST MATCH WINS, BY DECLARATION ORDER. `name` was listed under
 *      `firstName`, so a file with both "Name" and "First Name" gave
 *      `firstName` to whichever came first in the file and dropped the other.
 *
 *   3. A GUESS WAS INDISTINGUISHABLE FROM A CERTAINTY. An exact alias hit and
 *      a vague one produced the same pre-selected mapping, so a "budget" column
 *      arrived in "estimated value" already ticked.
 *
 *   4. COLLISIONS WERE INVISIBLE. Two columns claiming one field silently left
 *      one of them unimported.
 *
 * The replacement reports everything it does and everything it declines to do.
 * It still only ever SUGGESTS: the import uses the mapping the client sends
 * back, and `suggest()` output is a proposal on a screen.
 */

// -----------------------------------------------------------------------------
// Aliases
// -----------------------------------------------------------------------------

/**
 * Header spellings seen in real exports, already normalised for comparison.
 *
 * An EXACT entry matches only the whole normalised header. These are the
 * spellings we are willing to act on without asking.
 */
const EXACT_ALIASES: Record<ImportableField, readonly string[]> = {
  firstName: [
    'firstname',
    'first',
    'fname',
    'givenname',
    // Whole-name spellings. They land in `firstName` because the importer
    // splits nothing: putting "Dana Whitfield" in firstName is honest, while
    // guessing where the surname starts is wrong for most of the world.
    'name',
    'fullname',
    'contactname',
    'leadname',
    'customername',
    'clientname',
    'partyname',
  ],
  lastName: ['lastname', 'last', 'lname', 'surname', 'familyname'],
  companyName: [
    'company',
    'companyname',
    'organisation',
    'organization',
    'organisationname',
    'organizationname',
    'business',
    'businessname',
    'firm',
    'firmname',
    'account',
    'accountname',
  ],
  mobile: [
    'mobile',
    'mobileno',
    'mobilenumber',
    'phone',
    'phoneno',
    'phonenumber',
    'contact',
    'contactno',
    'contactnumber',
    'cell',
    'cellphone',
    'cellno',
    'whatsapp',
    'whatsappno',
    'whatsappnumber',
    'tel',
    'telephone',
    'telno',
  ],
  email: ['email', 'emailaddress', 'emailid', 'mail', 'mailid', 'eid'],

  // --- the address, which had no aliases at all before this release ---------
  addressLine1: [
    'address',
    'address1',
    'addressline1',
    'addressline',
    'addr',
    'addr1',
    'street',
    'streetaddress',
    'street1',
    'line1',
    'billingaddress',
    'shippingaddress',
    'deliveryaddress',
    'fulladdress',
    'postaladdress',
  ],
  addressLine2: [
    'address2',
    'addressline2',
    'addr2',
    'street2',
    'line2',
    'landmark',
    'area',
    'locality',
    'addressline3',
  ],
  city: ['city', 'cityname', 'town', 'village', 'taluka', 'tehsil'],
  state: [
    'state',
    'statename',
    'province',
    'region',
    'county',
    'district',
    'stateut',
    'stateunionterritory',
  ],
  postalCode: [
    'pin',
    'pincode',
    'pinno',
    'postalcode',
    'postcode',
    'zip',
    'zipcode',
    'postal',
    'eircode',
  ],
  country: ['country', 'countryname', 'countrycode', 'nation'],

  source: ['source', 'leadsource', 'channel', 'campaign', 'medium', 'referredby', 'referral'],
  productInterest: [
    'product',
    'productinterest',
    'products',
    'interest',
    'interestedin',
    'requirement',
    'requirements',
    'enquiryfor',
    'enquiryabout',
    'item',
    'itemname',
    'material',
  ],
  estimatedValue: [
    'value',
    'estimatedvalue',
    'estvalue',
    'dealvalue',
    'dealsize',
    'opportunityvalue',
    'expectedvalue',
    'expectedrevenue',
  ],
  nextFollowUpAt: [
    'followup',
    'followupdate',
    'nextfollowup',
    'nextfollowupat',
    'nextfollowupdate',
    'nextaction',
    'nextactiondate',
    'duedate',
    'reminder',
    'reminderdate',
  ],
};

/**
 * Spellings we are willing to GUESS at but not act on.
 *
 * Matched as a substring of the normalised header, and the result is reported
 * as `fuzzy` and left unselected — the user ticks it or does not.
 *
 * Every entry here is a word that is genuinely ambiguous in a lead export:
 *
 *   `amount`, `budget`, `price`, `rate`  Could be the deal size, a unit price,
 *     or a quantity in rupees per kilo. Guessing wrong puts a unit price in the
 *     pipeline value and overstates the forecast by three orders of magnitude.
 *   `location`, `place`  Could be a city, a state or a full address.
 *   `date`  Could be the follow-up, the enquiry date or the creation date.
 *   `number`, `no`  Could be a phone number, an invoice number or a row index.
 *   `notes`, `remarks`  Often hold the product interest and often hold
 *     something nobody should import.
 */
const FUZZY_HINTS: readonly { contains: string; field: ImportableField }[] = [
  { contains: 'amount', field: 'estimatedValue' },
  { contains: 'budget', field: 'estimatedValue' },
  { contains: 'price', field: 'estimatedValue' },
  { contains: 'rate', field: 'estimatedValue' },
  { contains: 'revenue', field: 'estimatedValue' },
  { contains: 'location', field: 'city' },
  { contains: 'place', field: 'city' },
  { contains: 'address', field: 'addressLine1' },
  { contains: 'phone', field: 'mobile' },
  { contains: 'mobile', field: 'mobile' },
  { contains: 'email', field: 'email' },
  { contains: 'mail', field: 'email' },
  { contains: 'company', field: 'companyName' },
  { contains: 'name', field: 'firstName' },
  { contains: 'city', field: 'city' },
  { contains: 'state', field: 'state' },
  { contains: 'pin', field: 'postalCode' },
  { contains: 'zip', field: 'postalCode' },
  { contains: 'country', field: 'country' },
  { contains: 'product', field: 'productInterest' },
  { contains: 'remark', field: 'productInterest' },
  { contains: 'note', field: 'productInterest' },
  { contains: 'followup', field: 'nextFollowUpAt' },
  { contains: 'date', field: 'nextFollowUpAt' },
  { contains: 'source', field: 'source' },
];

/**
 * Header text reduced to what a comparison should care about.
 *
 * Lower-cased and stripped of everything that is not a letter or digit, which
 * makes `"Address Line 1"`, `"address_line_1"`, `"ADDRESSLINE1"` and
 * `"  Address-Line-1  "` the same key. That covers capitalisation, spacing,
 * punctuation and the separator conventions four different export tools use.
 *
 * A BOM (U+FEFF) is stripped explicitly as well as by the class: a BOM that survived
 * the parser would otherwise make the FIRST header — usually the name — the one
 * column that never matches, which is the hardest version of this bug to see.
 */
export function normaliseHeader(header: string): string {
  return header
    .replace(/\uFEFF/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// -----------------------------------------------------------------------------
// Suggesting
// -----------------------------------------------------------------------------

export interface MappingSuggestion {
  columns: SuggestedColumn[];
  /** Only the confident ones. A fuzzy guess is not in here. */
  mapping: Record<string, ImportableField>;
  unmapped: string[];
  needsConfirmation: SuggestedColumn[];
  collisions: MappingCollision[];
  duplicateHeaders: string[];
  missingRequired: ImportableField[];
}

/**
 * A proposal for the mapping screen. Never a decision.
 *
 * Two passes, and the order is the fix for defect 2 above: every EXACT match in
 * the whole file is taken first, so a file containing both "Name" and "First
 * Name" gives the field to the better spelling rather than to whichever column
 * appears first. Fuzzy hints then fill only what is still unclaimed.
 */
export function suggestMapping(headers: string[]): MappingSuggestion {
  const columns: SuggestedColumn[] = headers.map((header, index) => ({
    header,
    index,
    field: null,
    confidence: null,
    note: null,
  }));

  const duplicateHeaders = findDuplicateHeaders(headers);
  const claimed = new Map<ImportableField, number>();

  // --- pass 1: exact alias hits ---------------------------------------------
  for (const column of columns) {
    const key = normaliseHeader(column.header);
    if (!key) {
      column.note = 'This column has no name, so nothing can be mapped to it.';
      continue;
    }

    const field = IMPORTABLE_FIELDS.find((candidate) => EXACT_ALIASES[candidate].includes(key));
    if (!field) continue;

    if (claimed.has(field)) {
      // Left unmapped on purpose. Which of two "Phone" columns is the mobile is
      // not something this code can know, so it says so instead of choosing.
      column.note = `Also looks like ${field}, which "${headers[claimed.get(field) as number] ?? ''}" is already mapped to. Pick one.`;
      continue;
    }

    column.field = field;
    column.confidence = 'exact';
    claimed.set(field, column.index);
  }

  // --- pass 2: fuzzy hints, for what is still unclaimed ---------------------
  for (const column of columns) {
    if (column.field || column.note) continue;

    const key = normaliseHeader(column.header);
    const hint = FUZZY_HINTS.find(
      (candidate) => key.includes(candidate.contains) && !claimed.has(candidate.field),
    );

    if (!hint) {
      column.note = 'Not recognised. Choose a field for it, or leave it out.';
      continue;
    }

    /*
     * Suggested, and deliberately NOT claimed.
     *
     * `claimed` is left alone so a later exact match for the same field still
     * wins, and the field is reported as needing confirmation rather than
     * folded into `mapping`. A guess the user never agreed to is the bug this
     * whole file exists to prevent.
     */
    column.field = hint.field;
    column.confidence = 'fuzzy';
    column.note = `Guessed from the column name. Check this before importing.`;
  }

  const mapping: Record<string, ImportableField> = {};
  for (const column of columns) {
    if (column.field && column.confidence === 'exact') mapping[column.header] = column.field;
  }

  return {
    columns,
    mapping,
    unmapped: columns.filter((column) => column.confidence !== 'exact').map((c) => c.header),
    needsConfirmation: columns.filter((column) => column.confidence === 'fuzzy'),
    collisions: findCollisions(mapping),
    duplicateHeaders,
    missingRequired: REQUIRED_IMPORT_FIELDS.filter(
      (field) => !Object.values(mapping).includes(field),
    ),
  };
}

/**
 * Headers that appear more than once.
 *
 * Reported because the row reader addresses columns BY INDEX, so two columns
 * named "Phone" are distinguishable to the code but not in a
 * `Record<header, field>` mapping — the second silently replaces the first.
 * Telling the user is better than picking.
 */
export function findDuplicateHeaders(headers: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const header of headers) {
    const key = normaliseHeader(header);
    if (!key) continue;
    if (seen.has(key)) duplicates.add(header);
    seen.add(key);
  }

  return [...duplicates];
}

/** Two or more headers pointing at one destination field. */
export function findCollisions(mapping: Record<string, ImportableField>): MappingCollision[] {
  const byField = new Map<ImportableField, string[]>();

  for (const [header, field] of Object.entries(mapping)) {
    byField.set(field, [...(byField.get(field) ?? []), header]);
  }

  return [...byField.entries()]
    .filter(([, headers]) => headers.length > 1)
    .map(([field, headers]) => ({ field, headers }));
}

/**
 * The caller's mapping, checked before anything is imported with it.
 *
 * Returns the problems rather than throwing, so the preview can show all of
 * them at once instead of one per round trip.
 */
export function validateMapping(
  mapping: Record<string, string>,
  headers: string[],
): { unknownFields: string[]; unknownHeaders: string[]; collisions: MappingCollision[] } {
  const unknownFields: string[] = [];
  const unknownHeaders: string[] = [];
  const clean: Record<string, ImportableField> = {};

  for (const [header, field] of Object.entries(mapping)) {
    if (!headers.includes(header)) {
      unknownHeaders.push(header);
      continue;
    }
    if (!IMPORTABLE_FIELDS.includes(field as ImportableField)) {
      unknownFields.push(field);
      continue;
    }
    clean[header] = field as ImportableField;
  }

  return { unknownFields, unknownHeaders, collisions: findCollisions(clean) };
}
