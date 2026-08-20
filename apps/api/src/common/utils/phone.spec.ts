import { PhoneParseError, formatPhone, toE164 } from './phone';

describe('toE164', () => {
  describe('input already international', () => {
    it.each([
      ['+14155552671', '+14155552671'],
      ['+1 415 555 2671', '+14155552671'],
      ['+44 20 7946 0958', '+442079460958'],
      ['+91 98200 11001', '+919820011001'],
      ['(  +65  ) 6123-4567', '+6561234567'],
    ])('normalises %s', (input, expected) => {
      expect(toE164(input, 'US')).toBe(expected);
    });

    it('treats a leading 00 as the international prefix', () => {
      // Common across Europe and much of Asia.
      expect(toE164('0044 20 7946 0958', 'IN')).toBe('+442079460958');
    });

    it('ignores the organization country when the input is international', () => {
      // A UK number entered by an Indian tenant must stay a UK number.
      expect(toE164('+44 20 7946 0958', 'IN')).toBe('+442079460958');
    });
  });

  describe('national input, resolved via the organization country', () => {
    it('applies the Indian dialling code', () => {
      expect(toE164('98200 11001', 'IN')).toBe('+919820011001');
    });

    it('applies the US dialling code', () => {
      expect(toE164('(415) 555-2671', 'US')).toBe('+14155552671');
    });

    it('does not double a country code the user already typed', () => {
      // "919820011001" is a very common paste; prefixing 91 again would produce
      // a number that silently never matches the same customer entered normally.
      expect(toE164('919820011001', 'IN')).toBe('+919820011001');
    });

    it('rejects a national number when the country has no configured code', () => {
      expect(() => toE164('12345678', 'ZZ')).toThrow(PhoneParseError);
    });
  });

  describe('the point of canonicalising', () => {
    it('maps every spelling of one number onto a single value', () => {
      const spellings = ['+91 98200 11001', '09820011001', '98200-11001', '9820011001'];
      const canonical = new Set(spellings.map((value) => toE164(value, 'IN')));

      // If this ever produces more than one value, duplicate detection silently
      // stops working for customers who type their number differently.
      expect(canonical.size).toBe(1);
    });

    it('keeps identical national numbers in different countries distinct', () => {
      // The reason a bare national number cannot be the stored form.
      expect(toE164('4155552671', 'US')).not.toBe(toE164('4155552671', 'GB'));
    });
  });

  describe('rejection', () => {
    it.each(['', '   ', 'abc', '+', '+123'])('rejects %p', (input) => {
      expect(() => toE164(input, 'US')).toThrow(PhoneParseError);
    });

    it('rejects more than 15 digits, the E.164 maximum', () => {
      expect(() => toE164('+1234567890123456', 'US')).toThrow(PhoneParseError);
    });
  });
});

describe('formatPhone', () => {
  it('groups a known country code readably', () => {
    expect(formatPhone('+919820011001')).toContain('+91 ');
  });

  it('returns E.164 unchanged when the code is unknown', () => {
    expect(formatPhone('+99912345678')).toBe('+99912345678');
  });
});
