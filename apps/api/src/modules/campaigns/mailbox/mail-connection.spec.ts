import { classifySmtpError, describeConnectionError, scrubResponse } from './mail-connection';
import { MailHostError } from './mail-host';

const smtpError = (props: Record<string, unknown>) =>
  Object.assign(new Error(String(props['message'] ?? 'smtp')), props);

describe('classifying an SMTP failure', () => {
  it('a refused sign-in stops the mailbox, not the recipient', () => {
    expect(
      classifySmtpError(smtpError({ code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }))
        .kind,
    ).toBe('MAILBOX');
  });

  it('5xx at RCPT is permanent and marks the address as unknown', () => {
    const outcome = classifySmtpError(
      smtpError({ responseCode: 550, command: 'RCPT TO', message: '550 5.1.1 No such user' }),
    );
    expect(outcome).toMatchObject({ kind: 'PERMANENT', code: 550, recipientUnknown: true });
  });

  it('5xx after the body (content rejected) is permanent, but the address is not unknown', () => {
    const outcome = classifySmtpError(
      smtpError({
        responseCode: 554,
        command: 'DATA',
        message: '554 5.7.1 Message rejected as spam',
      }),
    );
    expect(outcome).toMatchObject({ kind: 'PERMANENT', recipientUnknown: false });
  });

  it.each([
    [{ responseCode: 421, command: 'CONN' }],
    [{ responseCode: 451, command: 'RCPT TO' }],
    [{ responseCode: 452, command: 'DATA' }], // an explicit deferral after the body is still "not accepted"
  ])('4xx is retried: %j', (props) => {
    expect(classifySmtpError(smtpError(props)).kind).toBe('RETRY');
  });

  it.each([
    [{ code: 'ETIMEDOUT', command: 'CONN' }],
    [{ code: 'ECONNREFUSED' }],
    [{ code: 'ESOCKET', command: 'EHLO' }],
    [{ code: 'ESOCKET', command: 'MAIL FROM' }],
    [{ code: 'ETIMEDOUT', command: 'RCPT TO' }],
  ])('a connection failure BEFORE the body is retried: %j', (props) => {
    expect(classifySmtpError(smtpError(props)).kind).toBe('RETRY');
  });

  it.each([
    [{ code: 'ETIMEDOUT', command: 'DATA' }],
    [{ code: 'ESOCKET', command: 'DATA' }],
    [{ code: 'ESOCKET' }],
    [{ message: 'Connection closed unexpectedly' }],
  ])('a lost answer AFTER the body may have started is UNCERTAIN, never retried: %j', (props) => {
    expect(classifySmtpError(smtpError(props)).kind).toBe('UNCERTAIN');
  });

  it('an unreachable or private host is a mailbox problem', () => {
    expect(classifySmtpError(new MailHostError('PRIVATE_ADDRESS', 'private')).kind).toBe('MAILBOX');
  });
});

describe('connection error messages', () => {
  it('never repeat the server’s text, which can echo credentials', () => {
    const message = describeConnectionError(
      smtpError({
        code: 'EAUTH',
        responseCode: 535,
        message: '535 Incorrect authentication data for sales@cravionventures.com password hunter2',
      }),
      'SMTP',
    );
    expect(message).toContain('rejected the username or password');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('sales@');
  });

  it.each([
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'certificate'],
    [{ code: 'ESOCKET', cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }, 'certificate'],
    [{ code: 'ETIMEDOUT' }, 'timed out'],
    [{ code: 'ECONNREFUSED' }, 'refused'],
    [{ authenticationFailed: true }, 'username or password'],
  ])('%j → %s', (props, expected) => {
    expect(describeConnectionError(smtpError(props), 'IMAP')).toContain(expected);
  });

  it('scrubs AUTH arguments from stored responses', () => {
    expect(scrubResponse('AUTH PLAIN AGZvbwBiYXI=\r\n535 bad')).toBe('AUTH PLAIN *** 535 bad');
  });
});
