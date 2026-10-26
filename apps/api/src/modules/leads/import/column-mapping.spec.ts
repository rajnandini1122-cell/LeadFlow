import { findCollisions, findDuplicateHeaders, normaliseHeader, suggestMapping, validateMapping } from './column-mapping';

/**
 * Header matching.
 *
 * Every case here corresponds to a reported mapping defect: an address column
 * that vanished, a "budget" column that silently became the pipeline value, two
 * phone columns where one went missing, and a header the matcher ignored
 * without saying so.
 */
describe('normaliseHeader', () => {
  it.each([
    ['Address Line 1', 'addressline1'],
    ['address_line_1', 'addressline1'],
    ['ADDRESS-LINE-1', 'addressline1'],
    ['  Address Line 1  ', 'addressline1'],
    ['Mobile No.', 'mobileno'],
  ])('reduces %s to %s', (input, expected) => {
    expect(normaliseHeader(input)).toBe(expected);
  });

  it('strips a BOM, so the first column is not the one that never matches', () => {
    expect(normaliseHeader(`${String.fromCharCode(0xfeff)}firstName`)).toBe('firstname');
  });
});

describe('suggestMapping', () => {
  it('matches common header spellings exactly', () => {
    const { mapping } = suggestMapping(['First Name', 'Mobile No.', 'Company']);

    expect(mapping).toEqual({
      'First Name': 'firstName',
      'Mobile No.': 'mobile',
      Company: 'companyName',
    });
  });

  describe('the address, which previously had no aliases at all', () => {
    it.each([
      ['Address Line 1', 'addressLine1'],
      ['Street Address', 'addressLine1'],
      ['Billing Address', 'addressLine1'],
      ['Address Line 2', 'addressLine2'],
      ['Landmark', 'addressLine2'],
      ['City', 'city'],
      ['District', 'state'],
      ['State / UT', 'state'],
      ['PIN Code', 'postalCode'],
      ['Postcode', 'postalCode'],
      ['Zip', 'postalCode'],
      ['Country', 'country'],
    ])('maps %s to %s', (header, field) => {
      expect(suggestMapping([header]).mapping[header]).toBe(field);
    });

    it('maps a whole Indian address export in one pass', () => {
      const { mapping, unmapped } = suggestMapping([
        'Customer Name',
        'Mobile No.',
        'Email ID',
        'Address Line 1',
        'Address Line 2',
        'City',
        'State',
        'PIN Code',
        'Country',
      ]);

      // The file that could not be imported before this release: every address
      // column was dropped, so nine columns arrived as four.
      expect(Object.keys(mapping)).toHaveLength(9);
      expect(unmapped).toEqual([]);
      expect(mapping['PIN Code']).toBe('postalCode');
      expect(mapping['Address Line 2']).toBe('addressLine2');
    });
  });

  describe('confidence', () => {
    it('does not pre-select a guess', () => {
      /*
       * THE DEFECT. "Budget" is not the deal value — it may be a unit price or
       * a per-kilo rate — and the old matcher treated the guess and a certainty
       * identically, so it arrived pre-ticked and two thousand leads got the
       * wrong pipeline value.
       */
      const result = suggestMapping(['Budget']);

      expect(result.mapping['Budget']).toBeUndefined();
      expect(result.needsConfirmation).toHaveLength(1);
      expect(result.needsConfirmation[0]).toMatchObject({
        header: 'Budget',
        field: 'estimatedValue',
        confidence: 'fuzzy',
      });
    });

    it('marks an exact alias as exact', () => {
      expect(suggestMapping(['Estimated Value']).columns[0]).toMatchObject({
        field: 'estimatedValue',
        confidence: 'exact',
      });
    });

    it('prefers an exact match over a fuzzy one for the same field', () => {
      // "Location" is a fuzzy hint for city; "City" is exact. The exact column
      // must win the field, whichever order they appear in.
      const result = suggestMapping(['Location', 'City']);

      expect(result.mapping['City']).toBe('city');
      expect(result.mapping['Location']).toBeUndefined();
    });
  });

  it('gives a field to the better spelling, not to whichever came first', () => {
    /*
     * THE DEFECT. `name` was listed as an alias of firstName, so a file with
     * both "Name" and "First Name" handed firstName to whichever appeared
     * first in the file and dropped the other silently.
     *
     * Both spellings are exact aliases of firstName, so the SECOND is now
     * reported with a note instead of disappearing.
     */
    const result = suggestMapping(['Name', 'First Name']);

    expect(Object.values(result.mapping)).toEqual(['firstName']);
    const unclaimed = result.columns.find((column) => column.field === null);
    expect(unclaimed?.note).toMatch(/already mapped to/);
  });

  it('never silently drops an unrecognised column', () => {
    const result = suggestMapping(['Internal Ref', 'firstName']);

    expect(result.mapping['Internal Ref']).toBeUndefined();
    expect(result.unmapped).toContain('Internal Ref');
    // The note is the fix for "it vanished and nobody said anything".
    expect(result.columns.find((c) => c.header === 'Internal Ref')?.note).toMatch(
      /Not recognised/,
    );
  });

  it('reports a column with no name', () => {
    expect(suggestMapping(['']).columns[0]?.note).toMatch(/no name/);
  });

  it('reports the required fields nothing maps to', () => {
    expect(suggestMapping(['Internal Ref', 'Notes']).missingRequired).toEqual([
      'firstName',
      'mobile',
    ]);
  });
});

describe('findDuplicateHeaders', () => {
  it('reports a header appearing twice', () => {
    // Two columns called "Phone" are two indexes to the row reader but only one
    // key in a `Record<header, field>` mapping, so the second would silently
    // replace the first.
    expect(findDuplicateHeaders(['Phone', 'Email', 'Phone'])).toEqual(['Phone']);
  });

  it('treats differently-spelled identical headers as duplicates', () => {
    expect(findDuplicateHeaders(['Phone No', 'phone_no'])).toEqual(['phone_no']);
  });

  it('ignores repeated empty headers', () => {
    expect(findDuplicateHeaders(['a', '', ''])).toEqual([]);
  });
});

describe('findCollisions', () => {
  it('reports two headers claiming one field', () => {
    expect(findCollisions({ Phone: 'mobile', Cell: 'mobile' })).toEqual([
      { field: 'mobile', headers: ['Phone', 'Cell'] },
    ]);
  });

  it('is quiet when every field is claimed once', () => {
    expect(findCollisions({ Phone: 'mobile', Email: 'email' })).toEqual([]);
  });
});

describe('validateMapping', () => {
  it('reports a field that does not exist', () => {
    // A client guessing `"address"` instead of `"addressLine1"` used to have
    // the column silently filtered out by the row reader, and saw a successful
    // import with no addresses in it.
    const result = validateMapping({ Street: 'address' }, ['Street']);

    expect(result.unknownFields).toEqual(['address']);
  });

  it('reports a header that is not in the file', () => {
    expect(validateMapping({ Nope: 'mobile' }, ['Phone']).unknownHeaders).toEqual(['Nope']);
  });

  it('accepts a clean mapping', () => {
    const result = validateMapping({ Phone: 'mobile' }, ['Phone']);

    expect(result).toEqual({ unknownFields: [], unknownHeaders: [], collisions: [] });
  });
});
