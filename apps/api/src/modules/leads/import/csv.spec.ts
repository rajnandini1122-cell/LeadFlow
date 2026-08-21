import { CsvParseError, parseCsv, suggestMapping } from './csv';

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

  it('strips a UTF-8 BOM from the first header', () => {
    // Left in place it becomes part of the header name, and every mapping
    // against that column silently misses.
    const result = parseCsv('﻿firstName,mobile\nDana,9820011001');

    expect(result.headers[0]).toBe('firstName');
  });

  it('ignores a trailing blank line', () => {
    const result = parseCsv('name,phone\nDana,9820011001\n\n');

    expect(result.rows).toHaveLength(1);
  });

  it('preserves empty cells rather than shifting the row', () => {
    const result = parseCsv('a,b,c\n1,,3');

    expect(result.rows[0]).toEqual(['1', '', '3']);
  });

  it('rejects a file that ends inside a quoted value', () => {
    expect(() => parseCsv('name,note\nDana,"unterminated')).toThrow(CsvParseError);
  });

  it('rejects a file with no data rows', () => {
    expect(() => parseCsv('name,phone')).toThrow(CsvParseError);
  });

  it('refuses a file above the row cap', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `Dana,98200110${i}`).join('\n');

    expect(() => parseCsv(`name,phone\n${rows}`, 5)).toThrow(/more than 5 rows/);
  });
});

describe('suggestMapping', () => {
  it('matches common header spellings', () => {
    const mapping = suggestMapping(['First Name', 'Mobile No.', 'Company', 'Deal Value']);

    expect(mapping).toEqual({
      'First Name': 'firstName',
      'Mobile No.': 'mobile',
      Company: 'companyName',
      'Deal Value': 'estimatedValue',
    });
  });

  it('never maps two columns onto the same field', () => {
    // Otherwise the later column silently overwrites the earlier one.
    const mapping = suggestMapping(['Phone', 'Mobile']);

    expect(Object.values(mapping)).toEqual(['mobile']);
  });

  it('leaves unrecognised columns out entirely', () => {
    const mapping = suggestMapping(['Internal Ref', 'firstName']);

    expect(mapping['Internal Ref']).toBeUndefined();
    expect(mapping['firstName']).toBe('firstName');
  });
});
