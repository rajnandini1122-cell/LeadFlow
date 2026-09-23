import { splitPersonName } from './person-name';

/**
 * Splitting one name field into two columns.
 *
 * Tested carefully because getting somebody's name wrong is not a small error,
 * and because the temptation to be clever here is constant. Every case below is
 * really the same assertion: the split preserves what the person wrote and
 * claims nothing about it.
 */
describe('splitPersonName', () => {
  it('splits at the first space', () => {
    expect(splitPersonName('Dana Whitfield')).toEqual({
      firstName: 'Dana',
      lastName: 'Whitfield',
    });
  });

  it('keeps everything after the first word together', () => {
    // Four of five words survive. That is the split that loses the least text;
    // it is not a claim about which part is a surname.
    expect(splitPersonName('Ana Maria Ferreira da Silva')).toEqual({
      firstName: 'Ana',
      lastName: 'Maria Ferreira da Silva',
    });
  });

  it('treats a single word as a whole name', () => {
    // For a great many people this is the only name they have. Padding it, or
    // copying it into both columns, would put a surname on somebody who gave
    // none.
    expect(splitPersonName('Madonna')).toEqual({ firstName: 'Madonna' });
    expect(splitPersonName('Madonna')).not.toHaveProperty('lastName', 'Madonna');
  });

  it('collapses the whitespace nobody meant', () => {
    expect(splitPersonName('  Dana   Whitfield  ')).toEqual({
      firstName: 'Dana',
      lastName: 'Whitfield',
    });
  });

  it('does not reorder', () => {
    // A family-name-first convention is stored exactly as written. Detecting
    // one would mean guessing a culture from a string.
    expect(splitPersonName('Yamada Tarou')).toEqual({
      firstName: 'Yamada',
      lastName: 'Tarou',
    });
  });

  it('does not strip titles or infer anything from them', () => {
    // "Dr" stays part of the name rather than being moved into a field nobody
    // asked for, and nothing is inferred from "Mrs".
    expect(splitPersonName('Dr Anjali Rao')).toEqual({
      firstName: 'Dr',
      lastName: 'Anjali Rao',
    });
  });

  it('returns nothing usable as nothing', () => {
    // Undefined rather than a placeholder: a caller has to decide what an
    // enquiry with no name means, and "Unknown" in front of a salesperson
    // reads as a customer who typed it.
    expect(splitPersonName('')).toBeUndefined();
    expect(splitPersonName('   ')).toBeUndefined();
    expect(splitPersonName(null)).toBeUndefined();
    expect(splitPersonName(undefined)).toBeUndefined();
  });

  it('fits the columns rather than losing the record', () => {
    const long = `${'A'.repeat(100)} ${'B'.repeat(100)}`;
    const split = splitPersonName(long);

    // VarChar(80) both. Truncating beats refusing the enquiry.
    expect(split?.firstName).toHaveLength(80);
    expect(split?.lastName).toHaveLength(80);
  });

  it('keeps non-Latin scripts intact', () => {
    expect(splitPersonName('अंजलि राव')).toEqual({ firstName: 'अंजलि', lastName: 'राव' });
  });
});
