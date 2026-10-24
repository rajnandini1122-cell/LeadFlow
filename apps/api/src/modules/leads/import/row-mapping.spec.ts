import { isPlausibleEmail, parseAmount, parseDate, readRow, validateRow } from './row-mapping';

/**
 * Reading and validating one row.
 *
 * The parsing cases are the ones that caused rows to be rejected for values
 * that were perfectly valid in the file the user exported — which reads as "the
 * importer is broken" and is the hardest kind of defect to get reported
 * precisely.
 */
describe('readRow', () => {
  const headers = ['Name', 'Phone', 'City'];

  it('reads the mapped columns', () => {
    const values = readRow(headers, ['Dana', '9820011001', 'Pune'], {
      Name: 'firstName',
      Phone: 'mobile',
      City: 'city',
    });

    expect(values).toEqual({ firstName: 'Dana', mobile: '9820011001', city: 'Pune' });
  });

  it('ignores an unmapped column', () => {
    const values = readRow(headers, ['Dana', '9820011001', 'Pune'], { Name: 'firstName' });

    expect(values).toEqual({ firstName: 'Dana' });
  });

  it('treats an empty cell as absent, not as a blank value', () => {
    // So `""` in a CSV does not overwrite anything with an empty string.
    const values = readRow(headers, ['Dana', '', '  '], {
      Name: 'firstName',
      Phone: 'mobile',
      City: 'city',
    });

    expect(values).toEqual({ firstName: 'Dana' });
  });

  it('survives a row shorter than the header', () => {
    const values = readRow(headers, ['Dana'], { Name: 'firstName', City: 'city' });

    expect(values).toEqual({ firstName: 'Dana' });
  });

  it('keeps the first of two columns mapped to one field', () => {
    // The collision is reported separately; here the point is that it is
    // deterministic rather than "whichever came last".
    const values = readRow(['A', 'B'], ['first', 'second'], { A: 'firstName', B: 'firstName' });

    expect(values.firstName).toBe('first');
  });
});

describe('parseAmount', () => {
  it.each([
    ['250000', 250000],
    ['250000.50', 250000.5],
    // Indian lakh grouping, which is what a real export from this market
    // writes. `Number("2,50,000")` is NaN, so the row was rejected with "is
    // not a number" for a value that plainly is one.
    ['2,50,000', 250000],
    ['250,000', 250000],
    ['₹ 2,50,000', 250000],
    // "Rs." leaves a leading dot behind once stripped, and Number(".250000")
    // is 0.25 — a value a thousand times too small, with no error.
    ['Rs. 250000', 250000],
    ['INR 250000', 250000],
    ['.5', 0.5],
    ['  250000  ', 250000],
    ['-5000', -5000],
  ])('reads %s as %s', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each(['', 'abc', '12abc', '1.2.3', '--5'])('refuses %s', (input) => {
    expect(parseAmount(input)).toBeNull();
  });
});

describe('parseDate', () => {
  it('reads an ISO date', () => {
    expect(parseDate('2026-11-20')?.toISOString()).toBe('2026-11-20T00:00:00.000Z');
  });

  it('reads an ISO instant', () => {
    expect(parseDate('2026-11-20T10:30:00.000Z')?.toISOString()).toBe('2026-11-20T10:30:00.000Z');
  });

  it('reads DD/MM/YYYY as day-first', () => {
    /*
     * `new Date("01/02/2026")` is month-first in every JavaScript runtime, so
     * a file saying 1 February imported as 2 January — a silent eleven-month
     * error on a follow-up date, which surfaces as a reminder that never fires.
     *
     * Every file written for this product's users is day-first, so that is
     * what the explicit branch assumes.
     */
    expect(parseDate('01/02/2026')?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it.each(['20-11-2026', '20.11.2026', '20/11/2026'])('reads %s', (input) => {
    expect(parseDate(input)?.toISOString()).toBe('2026-11-20T00:00:00.000Z');
  });

  it('refuses a day that does not exist in that month', () => {
    // The Date constructor rolls 31 February over to 3 March rather than
    // failing, so the result is checked against what went in.
    expect(parseDate('31/02/2026')).toBeNull();
  });

  it.each(['', 'next tuesday', '2026', '45/01/2026', '20/13/2026'])('refuses %s', (input) => {
    expect(parseDate(input)).toBeNull();
  });
});

describe('isPlausibleEmail', () => {
  it.each(['dana@example.test', 'dana.w+tag@sub.example.co.in'])('accepts %s', (input) => {
    expect(isPlausibleEmail(input)).toBe(true);
  });

  it.each(['dana', 'dana@', '@example.test', 'dana@example', 'a b@example.test', 'a..b@x.test'])(
    'refuses %s',
    (input) => {
      expect(isPlausibleEmail(input)).toBe(false);
    },
  );
});

describe('validateRow', () => {
  const context = {
    country: 'IN',
    defaultNextFollowUpAt: '2026-11-20',
    missingRequired: [],
    headerCount: 3,
    columnCount: 3,
  };

  it('passes a complete row', () => {
    expect(
      validateRow({ firstName: 'Dana', mobile: '9820011001' }, context),
    ).toEqual([]);
  });

  it('reports a missing required field by name', () => {
    expect(validateRow({ mobile: '9820011001' }, context)).toEqual(['firstName is empty.']);
  });

  it('reports a required field nothing is mapped to', () => {
    const errors = validateRow({ mobile: '9820011001' }, {
      ...context,
      missingRequired: ['firstName'],
    });

    expect(errors[0]).toBe('No column is mapped to firstName, which is required.');
    // Not reported twice: once as unmapped, not again as empty.
    expect(errors).toHaveLength(1);
  });

  it('quotes the value it rejected', () => {
    // "mobile is not a valid phone number" sent people looking at the phone
    // column when the real cause was a delimiter the parser did not expect and
    // the whole row had landed in one cell.
    const errors = validateRow({ firstName: 'Dana', mobile: 'not-a-number' }, context);

    expect(errors.join(' ')).toContain('"not-a-number"');
  });

  it('reports a ragged row before blaming a field', () => {
    /*
     * More cells than headers nearly always means an unquoted comma, which
     * shifts every later column by one — so the name lands in the company
     * field and the phone number in the city. The row-shape error has to come
     * FIRST or the user goes looking in the wrong place.
     */
    const errors = validateRow({ firstName: 'Dana', mobile: 'Pune' }, {
      ...context,
      columnCount: 5,
    });

    expect(errors[0]).toMatch(/5 values but the header has 3 columns/);
    expect(errors[0]).toMatch(/needs wrapping in quotes/);
  });

  it('refuses a country that is not a two-letter code', () => {
    // Truncating "India" to "In" and storing it is how a country filter ends
    // up with four spellings of one country.
    const errors = validateRow(
      { firstName: 'Dana', mobile: '9820011001', country: 'India' },
      context,
    );

    expect(errors.join(' ')).toMatch(/not a two-letter country code/);
  });

  it('accepts a two-letter country in either case', () => {
    for (const country of ['IN', 'in', 'Ae']) {
      expect(
        validateRow({ firstName: 'Dana', mobile: '9820011001', country }, context),
      ).toEqual([]);
    }
  });

  it('reports a value longer than its column', () => {
    const errors = validateRow(
      { firstName: 'Dana', mobile: '9820011001', city: 'x'.repeat(81) },
      context,
    );

    // Reported here rather than arriving as a database error partway through
    // the file, with some rows written and some not.
    expect(errors.join(' ')).toMatch(/city is 81 characters; the limit is 80/);
  });

  it('requires a follow-up date when the import set no default', () => {
    const errors = validateRow({ firstName: 'Dana', mobile: '9820011001' }, {
      ...context,
      defaultNextFollowUpAt: undefined,
    });

    expect(errors.join(' ')).toMatch(/no default was set/);
  });

  it('accepts a day-first date in the row', () => {
    expect(
      validateRow(
        { firstName: 'Dana', mobile: '9820011001', nextFollowUpAt: '20/11/2026' },
        context,
      ),
    ).toEqual([]);
  });

  it('accepts an Indian-formatted amount', () => {
    expect(
      validateRow(
        { firstName: 'Dana', mobile: '9820011001', estimatedValue: '2,50,000' },
        context,
      ),
    ).toEqual([]);
  });
});
