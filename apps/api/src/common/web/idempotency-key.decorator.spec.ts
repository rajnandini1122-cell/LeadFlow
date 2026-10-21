import { AppException } from '../errors/app.exception';
import { parseIdempotencyKey } from './idempotency-key.decorator';

describe('parseIdempotencyKey', () => {
  it('is null when the header is absent or empty', () => {
    expect(parseIdempotencyKey(undefined)).toBeNull();
    expect(parseIdempotencyKey('')).toBeNull();
  });

  it('accepts a UUID, which is what the web client sends', () => {
    const key = '0b6f8f9e-3c1d-4f4a-9a57-2d6a3f1e9c11';
    expect(parseIdempotencyKey(key)).toBe(key);
  });

  it('takes the first value when the header is repeated', () => {
    expect(parseIdempotencyKey(['first-key-123', 'second-key-456'])).toBe('first-key-123');
  });

  it.each([
    ['too short', 'abc'],
    ['spaces', 'has spaces in it'],
    ['path characters', '../../etc/passwd'],
    ['too long', 'k'.repeat(101)],
  ])('refuses a malformed key (%s) instead of silently ignoring it', (_label, value) => {
    // Ignoring it would switch the caller's double-submit protection off
    // without telling them.
    expect(() => parseIdempotencyKey(value)).toThrow(AppException);
  });
});
