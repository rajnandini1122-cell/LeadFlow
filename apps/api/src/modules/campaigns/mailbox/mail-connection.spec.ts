import { classifySmtpError, describeConnectionError, scrubResponse } from './mail-connection';
import { MailHostError } from './mail-host';

const smtpError = (props: Record<string, unknown>) =>
  Object.assign(new Error(String(props['message'] ?? 'smtp')), props);

describe('classifying an SMTP failure', () => {
  it('a refused sign-in stops the mailbox, not the recipient', () => {
    expect(classifySmtpError(smtpError({ code: 'EAUTH', responseCode: 535 }), 'login').kind).toBe(
      'MAILBOX',
    );
  });

  it('an invalid certificate is a mailbox problem, never a retry', () => {
    expect(
      classifySmtpError(
        smtpError({ code: 'ESOCKET', cause: { code: 'CERT_HAS_EXPIRED' } }),
        'connect',
      ).kind,
    ).toBe('MAILBOX');
  });

  it('5xx at RCPT is permanent and marks the address as unknown', () => {
    const outcome = classifySmtpError(
      smtpError({ responseCode: 550, command: 'RCPT TO', message: '550 5.1.1 No such user' }),
      'send',
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
      'send',
    );
    expect(outcome).toMatchObject({ kind: 'PERMANENT', recipientUnknown: false });
  });

  it.each([
    [{ responseCode: 421 }, 'connect'],
    [{ responseCode: 451, command: 'RCPT TO' }, 'send'],
    [{ responseCode: 452, command: 'DATA' }, 'send'], // an explicit deferral after the body is still "not accepted"
  ] as const)('an explicit 4xx is retried: %j at %s', (props, stage) => {
    expect(classifySmtpError(smtpError(props), stage).kind).toBe('RETRY');
  });

  it.each([
    [{ code: 'ETIMEDOUT', command: 'CONN', message: 'Connection timeout' }, 'connect'],
    [{ code: 'ECONNREFUSED' }, 'connect'],
    [{ code: 'ESOCKET', command: 'EHLO' }, 'connect'],
    [{ code: 'ECONNECTION', message: 'Connection closed unexpectedly' }, 'login'],
  ] as const)(
    'a failure before anything about the message was sent is retried: %j at %s',
    (props, stage) => {
      expect(classifySmtpError(smtpError(props), stage).kind).toBe('RETRY');
    },
  );

  it.each([
    // nodemailer labels an idle-socket timeout 'CONN' whatever was in flight —
    // including the message body. The stage, not the label, decides.
    [{ code: 'ETIMEDOUT', command: 'CONN', message: 'Timeout' }],
    [{ code: 'ECONNECTION', message: 'Connection closed unexpectedly' }],
    [{ code: 'ESOCKET', command: 'DATA' }],
    [{ message: 'socket hang up' }],
  ])('a lost answer during the send step is UNCERTAIN, never retried: %j', (props) => {
    expect(classifySmtpError(smtpError(props), 'send').kind).toBe('UNCERTAIN');
  });

  it('an unreachable or private host is a mailbox problem', () => {
    expect(classifySmtpError(new MailHostError('PRIVATE_ADDRESS', 'private'), 'connect').kind).toBe(
      'MAILBOX',
    );
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
