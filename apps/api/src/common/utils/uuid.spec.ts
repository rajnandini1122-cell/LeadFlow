import { uuidv7 } from './uuid';

describe('uuidv7', () => {
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('produces a canonically formatted UUID', () => {
    expect(uuidv7()).toMatch(UUID_SHAPE);
  });

  it('sets the version nibble to 7', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(uuidv7()[14]).toBe('7');
    }
  });

  it('sets the RFC 9562 variant bits to 10xx', () => {
    for (let i = 0; i < 200; i += 1) {
      const variantNibble = parseInt(uuidv7()[19] as string, 16);
      expect(variantNibble & 0b1100).toBe(0b1000);
    }
  });

  it('encodes the timestamp in the leading 48 bits', () => {
    const now = 1_767_225_600_000; // 2026-01-01T00:00:00Z
    const encoded = uuidv7(now).replace(/-/g, '').slice(0, 12);
    expect(parseInt(encoded, 16)).toBe(now);
  });

  it('sorts lexicographically in timestamp order', () => {
    const earlier = uuidv7(1_000_000_000_000);
    const later = uuidv7(2_000_000_000_000);

    // This ordering property is the entire reason for choosing v7: it is what
    // keeps index inserts appending rather than scattering.
    expect(earlier < later).toBe(true);
  });

  it('does not collide across many draws at the same millisecond', () => {
    const now = Date.now();
    const generated = new Set(Array.from({ length: 5000 }, () => uuidv7(now)));
    expect(generated.size).toBe(5000);
  });
});
