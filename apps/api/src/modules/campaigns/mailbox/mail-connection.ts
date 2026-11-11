import { createTransport, type Transporter } from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { resolvePublicMailHost, MailHostError, type Lookup } from './mail-host';

/**
 * Connections to an organization's own mail server.
 *
 * Every connection: goes to an address checked by resolvePublicMailHost;
 * verifies the certificate against the HOSTNAME (SNI), never the address;
 * TLS 1.2 or later; implicit TLS, or STARTTLS that MUST succeed. There is no
 * setting, for anyone, that weakens any of that.
 */

export type MailSecurity = 'SSL_TLS' | 'STARTTLS';

export interface MailServer {
  host: string;
  port: number;
  security: MailSecurity;
}

export interface MailAccount {
  username: string;
  password: string;
  smtp: MailServer;
  imap: MailServer;
}

const CONNECTION_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 30_000;
/** The name LeadFlow gives itself in EHLO. */
const EHLO_NAME = 'leadflow.cravionventures.com';

export type TransportFactory = typeof createTransport;
export type ImapFactory = (options: ImapFlowOptions) => ImapFlow;

export interface ConnectionDeps {
  lookup?: Lookup;
  /**
   * Tests only: replaces the public-address resolution so a connection can reach
   * a local fake server. Production never sets it; the guard it bypasses has its
   * own tests (mail-host.spec.ts).
   */
  resolveHost?: (host: string) => Promise<string>;
  /** Tests only: the fake servers listen on ephemeral ports, not 465/993. */
  testPorts?: { smtp?: number; imap?: number };
  transportFactory?: TransportFactory;
  imapFactory?: ImapFactory;
  /** Tests only: trust this CA instead of the system store. Never set in production code paths. */
  testCa?: string;
}

export function resolveMailHost(host: string, deps: ConnectionDeps): Promise<string> {
  return deps.resolveHost ? deps.resolveHost(host) : resolvePublicMailHost(host, deps.lookup);
}

export async function smtpTransport(
  account: MailAccount,
  deps: ConnectionDeps = {},
): Promise<Transporter> {
  const address = await resolveMailHost(account.smtp.host, deps);
  const factory = deps.transportFactory ?? createTransport;
  return factory({
    host: address,
    port: deps.testPorts?.smtp ?? account.smtp.port,
    secure: account.smtp.security === 'SSL_TLS',
    requireTLS: account.smtp.security === 'STARTTLS',
    ignoreTLS: false,
    name: EHLO_NAME,
    auth: { user: account.username, pass: account.password },
    tls: {
      servername: account.smtp.host,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(deps.testCa ? { ca: deps.testCa } : {}),
    },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // Message content never reads the server's files or fetches URLs.
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
}

export async function imapClient(account: MailAccount, deps: ConnectionDeps = {}) {
  const address = await resolveMailHost(account.imap.host, deps);
  const options: ImapFlowOptions = {
    host: address,
    port: deps.testPorts?.imap ?? account.imap.port,
    secure: account.imap.security === 'SSL_TLS',
    doSTARTTLS: account.imap.security === 'STARTTLS' ? true : undefined,
    servername: account.imap.host,
    auth: { user: account.username, pass: account.password },
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(deps.testCa ? { ca: deps.testCa } : {}),
    },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
  };
  return (deps.imapFactory ?? ((o: ImapFlowOptions) => new ImapFlow(o)))(options);
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Safe to show to the administrator: never contains a credential or a server banner. */
  message: string;
}

/** Connect, negotiate TLS, authenticate, quit. Sends no message. */
export async function testSmtp(
  account: MailAccount,
  deps: ConnectionDeps = {},
): Promise<ConnectionTestResult> {
  let transport: Transporter | undefined;
  try {
    transport = await smtpTransport(account, deps);
    await transport.verify();
    return { ok: true, message: 'Connected and signed in to the SMTP server. No email was sent.' };
  } catch (error) {
    return { ok: false, message: describeConnectionError(error, 'SMTP') };
  } finally {
    transport?.close();
  }
}

/** Connect, negotiate TLS, sign in, open INBOX read-only, log out. Changes nothing. */
export async function testImap(
  account: MailAccount,
  deps: ConnectionDeps = {},
): Promise<ConnectionTestResult> {
  let client: Awaited<ReturnType<typeof imapClient>> | undefined;
  try {
    client = await imapClient(account, deps);
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    await client.logout();
    return {
      ok: true,
      message: 'Connected and signed in to the IMAP server; the inbox opened read-only.',
    };
  } catch (error) {
    try {
      client?.close();
    } catch {
      // already closed
    }
    return { ok: false, message: describeConnectionError(error, 'IMAP') };
  }
}

const TLS_CERT_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

interface MailError {
  code?: string;
  responseCode?: number;
  command?: string;
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  cause?: unknown;
  message?: string;
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const code = (current as MailError).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as MailError).cause;
  }
  return codes;
}

/**
 * A message an administrator can act on. Deliberately built from codes, never
 * from the server's own text, which can echo the username or worse.
 */
export function describeConnectionError(error: unknown, protocol: 'SMTP' | 'IMAP'): string {
  if (error instanceof MailHostError) return error.message;
  const e = (error ?? {}) as MailError;
  const codes = errorCodes(error);
  const text = String(e.message ?? '');

  if (
    e.authenticationFailed ||
    codes.includes('EAUTH') ||
    e.responseCode === 535 ||
    /AUTHENTICATIONFAILED|Invalid credentials/i.test(text)
  ) {
    return `The ${protocol} server rejected the username or password. If the provider requires an app password, use one.`;
  }
  if (codes.some((code) => TLS_CERT_CODES.has(code)) || /certificate/i.test(text)) {
    return `The ${protocol} server’s TLS certificate is not valid for this hostname. Check the hostname; LeadFlow does not connect without a valid certificate.`;
  }
  if (codes.includes('ETLS') || /STARTTLS|TLS/i.test(text)) {
    return `A secure (TLS) connection to the ${protocol} server could not be established. Check the port and the secure connection type.`;
  }
  if (
    codes.some(
      (code) => code === 'ETIMEDOUT' || (code === 'ECONNECTION' && /timeout/i.test(text)),
    ) ||
    /timed? ?out/i.test(text)
  ) {
    return `The connection to the ${protocol} server timed out. The server, the port, or the network path from LeadFlow to it is not reachable.`;
  }
  if (codes.includes('ECONNREFUSED')) {
    return `The ${protocol} server refused the connection on this port.`;
  }
  if (codes.includes('ENOTFOUND') || codes.includes('EDNS')) {
    return `The ${protocol} server could not be found.`;
  }
  return `The ${protocol} connection failed. Check the hostname, port and secure connection type.`;
}

// --- delivery outcomes -----------------------------------------------------------

export type SmtpOutcome =
  /** The server took responsibility for the message (2xx after the body). */
  | { kind: 'ACCEPTED'; code: number | null; response: string }
  /** Refused before or after the body with 4xx, or the connection failed before the body was sent. Safe to retry. */
  | { kind: 'RETRY'; code: number | null; response: string }
  /** Refused with 5xx. Not accepted; retrying cannot help. */
  | { kind: 'PERMANENT'; code: number; response: string; recipientUnknown: boolean }
  /** The body may have reached the server and its answer was lost. NOT retried. */
  | { kind: 'UNCERTAIN'; code: number | null; response: string }
  /** The mailbox itself is broken (sign-in refused): stop the campaign, keep the recipient queued. */
  | { kind: 'MAILBOX'; code: number | null; response: string };

/**
 * How far the conversation got, tracked by LeadFlow itself.
 *
 * nodemailer's own `command` on an error is NOT a reliable guide: an idle
 * socket timeout is reported as 'CONN' whatever was in flight, including the
 * message body. Trusting it would retry a message the server may already have
 * taken. So the conversation is driven step by step and the stage is known:
 *
 *   connect, login — nothing about the message has been sent: safe to retry;
 *   send           — MAIL FROM, RCPT TO and the body: without an explicit
 *                    reply code, the outcome is unknown.
 */
export type SmtpStage = 'connect' | 'login' | 'send';

export function classifySmtpError(error: unknown, stage: SmtpStage): SmtpOutcome {
  const e = (error ?? {}) as MailError;
  const code = typeof e.responseCode === 'number' ? e.responseCode : null;
  const response = scrubResponse(String(e.message ?? 'SMTP error'));
  const codes = errorCodes(error);

  if (error instanceof MailHostError) return { kind: 'MAILBOX', code: null, response };
  if (stage === 'login' && (codes.includes('EAUTH') || (code !== null && code >= 500))) {
    return { kind: 'MAILBOX', code, response };
  }
  if (codes.some((c) => TLS_CERT_CODES.has(c))) return { kind: 'MAILBOX', code, response };

  if (code !== null && code >= 500 && code < 600) {
    // 550/551/553 at RCPT, or 5.1.x enhanced codes, mean the address itself is bad.
    const recipientUnknown =
      (e.command === 'RCPT TO' && [550, 551, 553].includes(code)) ||
      /\b5\.1\.[0-9]\b/.test(response);
    return { kind: 'PERMANENT', code, response, recipientUnknown };
  }
  if (code !== null && code >= 400 && code < 500) {
    // An explicit deferral is an explicit "not accepted", at any stage.
    return { kind: 'RETRY', code, response };
  }
  // No reply code: the connection failed or went silent.
  return stage === 'send'
    ? { kind: 'UNCERTAIN', code, response }
    : { kind: 'RETRY', code, response };
}

/** The finished message, exactly as it will be transmitted. */
export function composeMessage(options: Mail.Options): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(options)
      .compile()
      .build((error, message) => (error ? reject(error) : resolve(message)));
  });
}

/**
 * One message, one connection: connect, sign in, send, quit — with the stage
 * known at every failure (see SmtpStage).
 */
export async function sendOnce(
  account: MailAccount,
  envelope: { from: string; to: string[] },
  raw: Buffer,
  deps: ConnectionDeps = {},
): Promise<SmtpOutcome> {
  let stage: SmtpStage = 'connect';
  let connection: SMTPConnection | undefined;
  try {
    const address = await resolveMailHost(account.smtp.host, deps);
    connection = new SMTPConnection({
      host: address,
      port: deps.testPorts?.smtp ?? account.smtp.port,
      secure: account.smtp.security === 'SSL_TLS',
      requireTLS: account.smtp.security === 'STARTTLS',
      ignoreTLS: false,
      name: EHLO_NAME,
      tls: {
        servername: account.smtp.host,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        ...(deps.testCa ? { ca: deps.testCa } : {}),
      },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      logger: false,
      debug: false,
    });
    // Errors are also emitted as events; the callbacks below are what count.
    connection.on('error', () => undefined);
    const conn = connection;
    await new Promise<void>((resolve, reject) =>
      conn.connect((err) => (err ? reject(err) : resolve())),
    );
    stage = 'login';
    await new Promise<void>((resolve, reject) =>
      conn.login({ user: account.username, pass: account.password }, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    stage = 'send';
    const info = await new Promise<SMTPConnection.SentMessageInfo>((resolve, reject) =>
      conn.send(envelope, raw, (err, result) => (err ? reject(err) : resolve(result))),
    );
    conn.quit();
    if ((info.accepted?.length ?? 0) === 0) {
      return {
        kind: 'PERMANENT',
        code: 550,
        response: 'The server accepted the message for no recipient.',
        recipientUnknown: false,
      };
    }
    return {
      kind: 'ACCEPTED',
      code: 250,
      response: scrubResponse(String(info.response ?? '250 accepted')),
    };
  } catch (error) {
    try {
      connection?.close();
    } catch {
      // already closed
    }
    return classifySmtpError(error, stage);
  }
}

/** Server responses are stored for diagnosis; strip anything that looks like an address of ours or a credential. */
export function scrubResponse(response: string): string {
  return response
    .replace(/\s+/g, ' ')
    .replace(/(AUTH\s+\S+\s+)\S+/gi, '$1***')
    .slice(0, 500);
}
