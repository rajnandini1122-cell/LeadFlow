import { CsvParseError, parseCsv, sniffDelimiter, toCsv } from './csv';

/**
 * The CSV reader, against the files real exports actually produce.
 *
 * Every case here is a file that broke something. The naive `split(',')`
 * version of this parser corrupted data silently rather than failing, which is
 * why the cases assert on VALUES rather than on "it did not throw".
 */
describe('parseCsv', () => {
  it('reads a plain file', () => {
    const result = parseCsv('name,phone\nDana,9820011001\nSam,9820011002');

    expect(result.headers).toEqual(['name', 'phone']);
    expect(result.rows).toEqual([
      ['Dana', '9820011001'],
      ['Sam', '9820011002'],
    ]);
  });

  it('keeps a comma inside a quoted field', () => {
    // The naive split(',') version puts "Pvt Ltd" in the phone column and
    // loses the number entirely — silent data corruption, not a crash.
    const result = parseCsv('name,company\nDana,"Acme, Pvt Ltd"');

    expect(result.rows[0]).toEqual(['Dana', 'Acme, Pvt Ltd']);
  });

  it('keeps a newline inside a quoted field', () => {
    const result = parseCsv('name,address\nDana,"12 High St\nSpringfield"');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.[1]).toBe('12 High St\nSpringfield');
  });

  it('unescapes a doubled quote', () => {
    const result = parseCsv('name,note\nDana,"said ""yes"" today"');

    expect(result.rows[0]?.[1]).toBe('said "yes" today');
  });

  it('handles CRLF line endings', () => {
    const result = parseCsv('name,phone\r\nDana,9820011001\r\n');

    expect(result.rows).toEqual([['Dana', '9820011001']]);
  });

  it('handles lone CR line endings', () => {
    // Classic Mac line endings, which some older export tools still write.
    const result = parseCsv('name,phone\rDana,9820011001\rSam,9820011002');

    expect(result.rows).toHaveLength(2);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    // Left in place it becomes part of the header name, so the FIRST column —
    // usually the name — is the one that never maps. That is the hardest
    // version of this bug to spot, because every other column works.
    const result = parseCsv(`${String.fromCharCode(0xfeff)}firstName,mobile\nDana,9820011001`);

    expect(result.headers[0]).toBe('firstName');
  });

  it('strips a BOM that appears on a later header', () => {
    const bom = String.fromCharCode(0xfeff);
    const result = parseCsv(`firstName,${bom}mobile\nDana,9820011001`);

    expect(result.headers[1]).toBe('mobile');
  });

  it('ignores a trailing blank line', () => {
    const result = parseCsv('name,phone\nDana,9820011001\n\n');

    expect(result.rows).toHaveLength(1);
  });

  it('ignores a wholly blank row in the middle', () => {
    // Excel leaves one between a table and a totals line.
    const result = parseCsv('name,phone\nDana,9820011001\n,\nSam,9820011002');

    expect(result.rows).toHaveLength(2);
  });

  it('preserves empty cells rather than shifting the row', () => {
    const result = parseCsv('a,b,c\n1,,3');

    expect(result.rows[0]).toEqual(['1', '', '3']);
  });

  it('keeps Unicode text intact', () => {
    // JavaScript strings are UTF-16 throughout, so this works by construction —
    // asserted anyway, because "by construction" is a claim and not evidence.
    const result = parseCsv('name,city\nदाना व्हिटफील्ड,पुणे');

    expect(result.rows[0]).toEqual(['दाना व्हिटफील्ड', 'पुणे']);
  });

  it('rejects a file that ends inside a quoted value', () => {
    expect(() => parseCsv('name,note\nDana,"unterminated')).toThrow(CsvParseError);
  });

  it('rejects a file with no data rows', () => {
    expect(() => parseCsv('name,phone')).toThrow(CsvParseError);
  });

  it('refuses a file above the row cap', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `Dana,98200110${i}`).join('\n');

    expect(() => parseCsv(`name,phone\n${rows}`, 5)).toThrow(/more than 5 data rows/);
  });

  describe('delimiters', () => {
    it('reads a semicolon-delimited file', () => {
      /*
       * Excel writes this in every locale where the comma is the decimal
       * separator — most of continental Europe.
       *
       * Before the delimiter sniff, such a file parsed as ONE column per row,
       * so the import failed with "no column mapped to firstName". That told
       * the user nothing about the real problem and the file looked fine in
       * Excel, which is the worst possible combination.
       */
      const result = parseCsv('firstName;mobile;city\nDana;9820011001;Pune');

      expect(result.delimiter).toBe(';');
      expect(result.headers).toEqual(['firstName', 'mobile', 'city']);
      expect(result.rows[0]).toEqual(['Dana', '9820011001', 'Pune']);
    });

    it('reads a tab-delimited file', () => {
      const result = parseCsv('firstName\tmobile\nDana\t9820011001');

      expect(result.delimiter).toBe('\t');
      expect(result.rows[0]).toEqual(['Dana', '9820011001']);
    });

    it('is not fooled by commas inside quoted header values', () => {
      const result = parseCsv('"Name, full";mobile\nDana;9820011001');

      expect(result.delimiter).toBe(';');
      expect(result.headers).toEqual(['Name, full', 'mobile']);
    });

    it('prefers the comma when nothing else appears', () => {
      expect(sniffDelimiter('firstName\nDana')).toBe(',');
    });

    it('decides on the header line, not the whole file', () => {
      // A comma-delimited file whose address column is full of semicolons must
      // not be read as semicolon-delimited.
      const result = parseCsv('firstName,address\nDana,"a; b; c; d; e"');

      expect(result.delimiter).toBe(',');
      expect(result.rows[0]?.[1]).toBe('a; b; c; d; e');
    });
  });
});

describe('toCsv', () => {
  it('writes a header and rows', () => {
    expect(toCsv(['a', 'b'], [['1', '2']])).toBe('a,b\r\n1,2\r\n');
  });

  it('quotes a value containing a comma', () => {
    expect(toCsv(['a'], [['x, y']])).toBe('a\r\n"x, y"\r\n');
  });

  it('doubles an inner quote', () => {
    expect(toCsv(['a'], [['say "hi"']])).toBe('a\r\n"say ""hi"""\r\n');
  });

  it('writes an empty string for a missing value', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe('a,b\r\n,\r\n');
  });

  it('neutralises a value Excel would run as a formula', () => {
    /*
     * CSV injection. This file is handed to a user and they are told to open
     * it, so a cell beginning `=`, `+`, `-` or `@` is a live formula in Excel
     * and Sheets — and the content comes from an uploaded file, which means it
     * comes from wherever that file came from.
     *
     * The leading apostrophe makes Excel treat it as text. The value is still
     * legible, which matters: this column exists so somebody can see what was
     * in the row they need to fix.
     */
    const output = toCsv(['value'], [['=1+1']]);

    expect(output).toBe('value\r\n"\'=1+1"\r\n');
    expect(output).not.toContain('\r\n=1+1');
  });

  it('neutralises the other three formula leaders', () => {
    for (const dangerous of ['+1', '-1', '@SUM(A1)']) {
      expect(toCsv(['v'], [[dangerous]])).toContain(`"'${dangerous}"`);
    }
  });
});
