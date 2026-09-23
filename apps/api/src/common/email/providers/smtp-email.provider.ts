import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { EmailDeliveryResult, EmailMessage, EmailProvider } from '../email.types';

/** Everything this provider needs, already validated by the env schema. */
export interface SmtpSettings {
  host: string;
  port: number;
  /** true = implicit TLS (usually 465); false = STARTTLS upgrade (usually 587). */
  secure: boolean;
  user: string;
  password: string;
  /** The envelope sender: an address, optionally with a display name. */
  from: string;
}

/** Injected in tests so the transport options can be asserted without a server. */
export type TransportFactory = typeof createTransport;

/*
 * Timeouts, in milliseconds.
 *
 * Every send in this application is awaited inside the request that triggered
 * it — a password reset, an invitation, a contact enquiry. Nodemailer's own
 * defaults are minutes long, so a mail server that accepts the connection and
 * then stops talking would hold an HTTP request open far past any sane
 * client's patience. Failing the send in seconds is better: the caller's
 * response does not depend on delivery anyway.
 */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * Generic SMTP delivery.
 *
 * Deliberately vendor-neutral: host, port, TLS mode and credentials all come
 * from configuration, so the same build talks to a cPanel mailbox, a corporate
 * relay or a transactional provider's SMTP endpoint without a code change.
 * There is no vendor SDK here and no vendor-specific branch.
 *
 * Two properties matter more than the plumbing:
 *
 *   Credentials never travel in the clear. With secure=false the connection
 *   MUST upgrade through STARTTLS — `requireTLS` makes a server that does not
 *   offer it an error rather than a silent cleartext AUTH — and certificate
 *   validation is never disabled.
 *
 *   Nothing sensitive reaches the log. Not the password, not the reset or
 *   invitation link, not the message body, and not the full recipient
 *   address: a failure records the tag and the recipient's domain, which is
 *   what an operator actually needs to tell "our relay is down" from "that
 *   customer's mail server is refusing us".
 */
@Injectable()
export class SmtpEmailProvider implements EmailProvider, OnModuleDestroy {
  readonly name = 'smtp';

  private readonly logger = new Logger('Email');
  private readonly transporter: Transporter;

  constructor(
    private readonly settings: SmtpSettings,
    transportFactory: TransportFactory = createTransport,
  ) {
    /*
     * One transporter for the process, created once and reused.
     *
     * createTransport opens nothing: the pool connects on the first message
     * and keeps a small number of authenticated connections rather than
     * repeating the TCP, TLS and AUTH handshake for every password reset.
     * Shared mailboxes commonly cap concurrent connections, hence two.
     */
    this.transporter = transportFactory({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
      // On an upgraded connection, refuse to continue if the upgrade is not
      // available. Never rejectUnauthorized:false — an unverified certificate
      // is an open invitation to the machine in the middle.
      requireTLS: !settings.secure,
      tls: { minVersion: 'TLSv1.2' },
      pool: true,
      maxConnections: 2,
      maxMessages: 100,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
  }

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    try {
      const info = await this.transporter.sendMail({
        from: this.settings.from,
        to: message.to.name
          ? { name: message.to.name, address: message.to.email }
          : message.to.email,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      // There is exactly one recipient, so "accepted" means that one was
      // taken. A server that answers 250 for nobody has not accepted
      // anything, whatever the absence of an exception suggests.
      const accepted = (info.accepted?.length ?? 0) > 0;

      if (!accepted) {
        this.logger.warn(
          { tag: message.tag, recipientDomain: domainOf(message.to.email) },
          'SMTP server accepted the connection but refused the recipient',
        );
      }

      return { accepted, messageId: info.messageId };
    } catch (error) {
      /*
       * Never rethrown, for the same reason EmailService swallows provider
       * errors: forgot-password answers identically whether or not the
       * account exists, and a send failure that turned into a 500 would
       * rebuild that enumeration oracle from the other side.
       */
      this.logger.error(
        {
          tag: message.tag,
          recipientDomain: domainOf(message.to.email),
          smtp: this.describeFailure(error),
        },
        'SMTP delivery failed',
      );

      return { accepted: false };
    }
  }

  /** Closes pooled connections so a shutdown does not leave sockets open. */
  async onModuleDestroy(): Promise<void> {
    this.transporter.close();
  }

  /**
   * An SMTP failure, reduced to what is safe to write down.
   *
   * Nodemailer errors carry the server's own reply, and an authentication
   * failure quotes the exchange that produced it. Rather than trusting that
   * never to contain a credential, this takes the few structured fields an
   * operator needs and scrubs the free text.
   */
  private describeFailure(error: unknown): Record<string, string | number | undefined> {
    const detail = error as { name?: string; message?: string; code?: string; responseCode?: number };

    return {
      name: detail?.name,
      code: detail?.code,
      responseCode: detail?.responseCode,
      message: this.redact(String(detail?.message ?? error)),
    };
  }

  private redact(text: string): string {
    return (
      text
        .split(this.settings.password)
        .join('[REDACTED]')
        .split(this.settings.user)
        .join('[REDACTED]')
        // AUTH payloads are base64. Any long unbroken run of it in an error
        // message is a credential far more often than it is anything useful.
        .replace(/[A-Za-z0-9+/]{24,}={0,2}/g, '[REDACTED]')
    );
  }
}

/** The part of an address that says whose mail server refused us. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}
