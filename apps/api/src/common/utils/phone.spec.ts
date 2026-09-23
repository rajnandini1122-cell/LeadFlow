import {
  PhoneParseError,
  formatPhone,
  normalizeProviderPhone,
  parsePhone,
  toE164,
} from './phone';

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
      /*
       * The reason a bare national number cannot be the stored form: 7911123456
       * is a real mobile in India AND a real mobile in the United Kingdom, and
       * they belong to two different people.
       *
       * This case used to use 4155552671 under US and GB, which is not a valid
       * GB number at all — the old parser prefixed +44 to it anyway and the
       * assertion passed on a number that could never ring. Two countries that
       * genuinely share the digits prove the point; a fabricated number only
       * proved the parser would fabricate.
       */
      expect(toE164('7911123456', 'IN')).toBe('+917911123456');
      expect(toE164('7911123456', 'GB')).toBe('+447911123456');
    });

    it('refuses a national number that is not valid in the country given', () => {
      // 4155552671 is a US number. Under GB it is nothing, and inventing
      // +444155552671 would store a number nobody can call.
      expect(() => toE164('4155552671', 'GB')).toThrow(PhoneParseError);
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

describe('India, the first market', () => {
  it.each(['9876543210', '+91 98765 43210', '+919876543210', '098765 43210', '0091 9876543210'])(
    'resolves %s to one canonical number',
    (input) => {
      expect(toE164(input, 'IN')).toBe('+919876543210');
    },
  );

  it('does NOT mangle a mobile that happens to begin with 91', () => {
    /*
     * The bug this whole change exists to remove. The previous parser saw a
     * national number starting with its own dialling code and cut it off, so
     * this real ten-digit mobile was stored as +9187654321 — a different
     * number, and one that cannot be dialled.
     *
     * The digits "91" at the front of a national number mean nothing on their
     * own; only the country's numbering plan can say whether a prefix is
     * present, which is precisely what a heuristic cannot know.
     */
    expect(toE164('9187654321', 'IN')).toBe('+919187654321');
  });

  it('still does not double a country code somebody pasted', () => {
    // The other half of the same problem: 919820011001 IS prefixed, and
    // prefixing it again would produce a number that never matches the same
    // customer entered normally.
    expect(toE164('919820011001', 'IN')).toBe('+919820011001');
  });

  it('leaves a local number under another country out of +91', () => {
    // An Indian default must never leak into a tenant somewhere else.
    expect(toE164('612345678', 'FR')).toBe('+33612345678');
    expect(toE164('612345678', 'DE')).toBe('+49612345678');
  });
});

describe('parsePhone', () => {
  it('distinguishes absent from invalid', () => {
    /*
     * The distinction callers need. An optional field nobody filled in is a
     * normal state; a value somebody DID type that cannot be parsed is an
     * error they can fix, and turning it into null instead is how unusable
     * data gets in without anybody noticing.
     */
    expect(parsePhone(undefined, { country: 'IN' })).toEqual({ status: 'ABSENT' });
    expect(parsePhone(null, { country: 'IN' })).toEqual({ status: 'ABSENT' });
    expect(parsePhone('   ', { country: 'IN' })).toEqual({ status: 'ABSENT' });

    expect(parsePhone('12345', { country: 'IN' })).toMatchObject({ status: 'INVALID' });
    expect(parsePhone('9876543210', { country: 'IN' })).toEqual({
      status: 'VALID',
      e164: '+919876543210',
    });
  });

  it('parses an international number with no country context at all', () => {
    expect(parsePhone('+919876543210')).toEqual({ status: 'VALID', e164: '+919876543210' });
  });

  it('asks for the country code when a local number has no country to sit in', () => {
    const result = parsePhone('9876543210', { country: undefined });

    expect(result.status).toBe('INVALID');
    expect(result).toMatchObject({ reason: expect.stringContaining('country code') });
  });

  it('ignores a country it has no numbering plan for', () => {
    // ZZ is the ISO code for "unknown region". Falling back to parsing the
    // number as international is right; inventing a dialling code is not.
    expect(parsePhone('9876543210', { country: 'ZZ' })).toMatchObject({ status: 'INVALID' });
    expect(parsePhone('+919876543210', { country: 'ZZ' })).toMatchObject({ status: 'VALID' });
  });
});

describe('normalizeProviderPhone', () => {
  it('reads provider digits as already international', () => {
    // Meta sends "919876543210" — a complete number with no plus, not a local
    // one. Parsing it against a tenant's country would make the result depend
    // on a setting that has nothing to do with the provider.
    expect(normalizeProviderPhone('919876543210')).toBe('+919876543210');
    expect(normalizeProviderPhone('+919876543210')).toBe('+919876543210');
  });

  it('gives one identity for the same number however the provider spells it', () => {
    /*
     * The failure this prevents: two ContactChannelIdentity rows for one real
     * person, and therefore two conversation histories, because one payload
     * carried a plus and another did not.
     */
    const spellings = ['919876543210', '+919876543210', '+91 98765 43210'];

    expect(new Set(spellings.map(normalizeProviderPhone)).size).toBe(1);
  });

  it('returns nothing rather than throwing on something unusable', () => {
    // Non-fatal by contract: an unparseable sender means we cannot match on
    // the number, not that the message should be rejected.
    expect(normalizeProviderPhone('0')).toBeUndefined();
    expect(normalizeProviderPhone('not-a-number')).toBeUndefined();
    expect(normalizeProviderPhone(undefined)).toBeUndefined();
    expect(normalizeProviderPhone('')).toBeUndefined();
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
