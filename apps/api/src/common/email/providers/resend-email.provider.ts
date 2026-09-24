import { Logger } from '@nestjs/common';
import type { EmailDeliveryResult, EmailMessage, EmailProvider } from '../email.types';

/**
 * Sends through Resend's HTTPS API.
 *
 * WHY THIS EXISTS. Railway blocks outbound SMTP: connections time out before
 * authentication, so nodemailer never gets far enough to report a useful
 * error. No SMTP configuration can fix that, because the problem is the
 * network path rather than the credentials. An HTTPS API is reachable from the
 * same host that could not open port 587.
 *
 * SMTP IS NOT REMOVED. It stays selectable, works wherever outbound SMTP is
 * allowed, and remains the fallback if this account is ever unavailable. Which
 * transport runs is a deployment decision, which is the entire point of the
 * EmailProvider seam.
 *
 * NO SDK, DELIBERATELY. This is one POST to one endpoint, and Node 24 has
 * global fetch. Adding `resend` would put another package into the production
 * image — which is built `npm ci --omit=dev`, so it ships — and this project
 * has held a zero-new-dependency line through several phases. The SDK's value
 * is typed responses and retry helpers; the first is four lines here and the
 * second is not something to do silently to transactional mail. Stubbing
 * `fetch` also makes this directly testable without a network or a library
 * mock.
 */
export interface ResendSettings {
  apiKey: string;
  /** Envelope sender, e.g. "LeadFlow <info@cravionventures.com>". */
  from: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Long enough for a normal API call, short enough not to hold a request open. */
const REQUEST_TIMEOUT_MS = 10_000;

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';

  private readonly logger = new Logger('Email');

  constructor(private readonly settings: ResendSettings) {}

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    /*
     * Bounded, because an unbounded call here would hold a password-reset
     * request open for as long as the provider felt like taking — and the one
     * thing worse than a slow email is a slow login page.
     */
    const abort = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          // The key is a header and never appears anywhere else — not in the
          // body, not in a log line, not in an error.
          Authorization: `Bearer ${this.settings.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.settings.from,
          to: [message.to.name ? `${message.to.name} <${message.to.email}>` : message.to.email],
          subject: message.subject,
          text: message.text,
          html: message.html,
          // Resend surfaces tags in its dashboard, which is how an operator
          // tells a stalled password reset from a stalled invitation.
          tags: [{ name: 'category', value: message.tag }],
        }),
        signal: abort,
      });

      if (!response.ok) {
        this.logger.error(
          {
            provider: this.name,
            tag: message.tag,
            recipientDomain: domainOf(message.to.email),
            status: response.status,
            resend: await this.describeRejection(response),
          },
          'Resend rejected the message',
        );

        return { accepted: false };
      }

      const body = (await response.json().catch(() => ({}))) as { id?: string };

      this.logger.log(
        {
          provider: this.name,
          tag: message.tag,
          recipientDomain: domainOf(message.to.email),
          messageId: body.id,
          accepted: true,
        },
        // "Accepted by the provider", never "delivered". Resend queues and
        // then delivers; a 200 here means it took responsibility for the
        // message, not that anybody has read it.
        'Resend accepted the message',
      );

      return { accepted: true, messageId: body.id };
    } catch (error) {
      /*
       * Never rethrown, for the same reason SmtpEmailProvider does not:
       * forgot-password answers identically whether or not the account exists,
       * and a send failure that became a 500 would rebuild that enumeration
       * oracle from the other side.
       */
      this.logger.error(
        {
          provider: this.name,
          tag: message.tag,
          recipientDomain: domainOf(message.to.email),
          resend: this.describeFailure(error),
        },
        'Resend request failed',
      );

      return { accepted: false };
    }
  }

  /**
   * The provider's own refusal, reduced to what is safe to write down.
   *
   * Resend answers with `{ name, message }` for a rejection — a bad domain, an
   * unverified sender, a malformed address. Useful, and still passed through
   * the same scrub as everything else: an error body is somebody else's free
   * text, and free text is exactly where a credential ends up when it ends up
   * anywhere.
   */
  private async describeRejection(
    response: Response,
  ): Promise<Record<string, string | undefined>> {
    const body = (await response.json().catch(() => ({}))) as {
      name?: string;
      message?: string;
    };

    return {
      name: body.name,
      message: this.redact(String(body.message ?? '')),
    };
  }

  private describeFailure(error: unknown): Record<string, string | undefined> {
    const detail = error as { name?: string; message?: string };

    // A timeout arrives as an AbortError, which is the single most likely
    // failure here and is worth being able to recognise at a glance.
    return {
      name: detail?.name,
      message: this.redact(String(detail?.message ?? error)),
    };
  }

  /**
   * Removes the API key from anything about to be logged.
   *
   * Belt and braces: the key is only ever placed in an Authorization header,
   * so it should not be able to reach here. "Should not" is not a property
   * worth betting a production credential on, and the cost is one string
   * replace on a path that only runs when something already went wrong.
   */
  private redact(text: string): string {
    return (
      text
        .split(this.settings.apiKey)
        .join('[REDACTED]')
        // Resend keys are `re_` followed by a long opaque run. Catches a key
        // other than ours — one pasted into an error by the provider, say.
        .replace(/re_[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    );
  }
}

/** The part of an address that says whose mail server is involved. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}
