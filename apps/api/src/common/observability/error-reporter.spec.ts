import { redactText } from './error-reporter';

/**
 * Redaction.
 *
 * An error report is shipped to a third party and retained for months, so
 * anything that leaks here outlives the incident it was captured for. These
 * tests are the guarantee that a stack trace containing a live token never
 * leaves the process.
 *
 * The bias is deliberate and one-directional: over-redacting costs a little
 * debugging context, under-redacting ships a working credential to someone
 * else's database.
 */
describe('redactText', () => {
  it('redacts a bearer token', () => {
    const redacted = redactText(
      'Request failed with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
    );

    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts a JWT even when nothing labels it', () => {
    /*
     * The case a keyword list misses. A token pasted into an error message
     * with no surrounding key is still a token.
     */
    const redacted = redactText(
      'unexpected value eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U in payload',
    );

    expect(redacted).toContain('[REDACTED_JWT]');
    expect(redacted).not.toContain('dozjgNryP4J3');
  });

  it('redacts credentials out of a connection string', () => {
    // The classic: a database error message quoting the whole DSN.
    const redacted = redactText(
      'could not connect to postgresql://leadflow:hunter2@db.internal:5432/leadflow',
    );

    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('leadflow:[REDACTED]@');
  });

  it('redacts password, token and secret values in any casing', () => {
    for (const sample of [
      'password=hunter2',
      'Password: hunter2',
      'refresh_token="hunter2"',
      'API_KEY: hunter2',
      'client_secret=hunter2',
    ]) {
      expect(redactText(sample)).not.toContain('hunter2');
    }
  });

  it('redacts a cookie header', () => {
    const redacted = redactText('cookie: refresh=abc123def456; path=/');
    expect(redacted).not.toContain('abc123def456');
  });

  it('leaves ordinary error text readable', () => {
    /*
     * Redaction that destroys the message defeats the purpose. A debuggable
     * report is the whole point.
     */
    const message = 'Lead not found for organization scope';
    expect(redactText(message)).toBe(message);

    expect(redactText('Cannot read properties of undefined (reading "wonValue")')).toContain(
      'wonValue',
    );
  });

  it('does not mangle a stack trace', () => {
    const stack =
      'Error: boom\n    at LeadsService.create (/app/src/modules/leads/leads.service.ts:42:11)';

    const redacted = redactText(stack);
    expect(redacted).toContain('LeadsService.create');
    expect(redacted).toContain('leads.service.ts:42:11');
  });
});
