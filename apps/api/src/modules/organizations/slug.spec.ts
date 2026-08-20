import { isReserved, isValidSlug, resolveAvailableSlug, slugify } from './slug';

describe('slugify', () => {
  it.each([
    ['Acme Corp', 'acme-corp'],
    ['  Björk & Sons, Ltd.  ', 'bjork-sons-ltd'],
    ['Café Münchën', 'cafe-munchen'],
    ['multiple   spaces', 'multiple-spaces'],
    ['---leading-and-trailing---', 'leading-and-trailing'],
    ['UPPER CASE', 'upper-case'],
    ['123 Numbers 456', '123-numbers-456'],
  ])('turns %p into %p', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('strips accents rather than dropping the letters', () => {
    // "bj-rk" would be the result of deleting non-ASCII instead of decomposing.
    expect(slugify('Björk')).toBe('bjork');
  });

  it('produces an empty string when there is nothing usable', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('never ends with a separator after truncation', () => {
    const slug = slugify(`${'a'.repeat(59)} b`);
    expect(slug).not.toMatch(/-$/);
  });

  it('always yields a valid slug for non-empty output', () => {
    for (const name of ['Acme Corp', 'Björk & Sons', 'X Y Z', '123 Numbers']) {
      expect(isValidSlug(slugify(name))).toBe(true);
    }
  });
});

describe('reserved slugs', () => {
  it.each(['api', 'admin', 'login', 'invitations'])('reserves %p', (slug) => {
    expect(isReserved(slug)).toBe(true);
  });

  it('does not reserve an ordinary name', () => {
    expect(isReserved('acme-corp')).toBe(false);
  });
});

describe('resolveAvailableSlug', () => {
  const takenSet = (taken: string[]) => async (slug: string) => taken.includes(slug);

  it('returns the base slug when it is free', async () => {
    expect(await resolveAvailableSlug('Acme Corp', takenSet([]))).toBe('acme-corp');
  });

  it('suffixes on collision instead of failing', async () => {
    // Two businesses may share a trading name; the second must still register.
    expect(await resolveAvailableSlug('Acme Corp', takenSet(['acme-corp']))).toBe('acme-corp-2');
  });

  it('keeps counting past several collisions', async () => {
    const taken = ['acme-corp', 'acme-corp-2', 'acme-corp-3'];
    expect(await resolveAvailableSlug('Acme Corp', takenSet(taken))).toBe('acme-corp-4');
  });

  it('skips reserved words', async () => {
    const slug = await resolveAvailableSlug('Admin', takenSet([]));
    expect(slug).not.toBe('admin');
    expect(isValidSlug(slug)).toBe(true);
  });

  it('falls back to a random suffix when sequential options run out', async () => {
    // Every sequential candidate (acme, acme-2 … acme-25) is at most 7
    // characters, so all are "taken"; only the 11-character random form
    // escapes, which is exactly the fallback path under test.
    const slug = await resolveAvailableSlug('Acme', async (candidate) => candidate.length < 11);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('produces a usable slug from a name with no usable characters', async () => {
    expect(await resolveAvailableSlug('!!!', takenSet([]))).toBe('org');
  });
});
