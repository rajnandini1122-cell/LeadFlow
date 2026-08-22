import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../../common/config/config.module';
import { openSecret, parseEncryptionKey } from '../../../../common/crypto/secret-box';

/**
 * The only code that speaks HTTP to Meta for sending.
 *
 * Everything above it deals in "send this text to this number on this
 * integration" and knows nothing about Graph API shapes, bearer tokens or
 * error envelopes. That boundary is what lets Instagram be added later as a
 * sibling rather than a rewrite.
 *
 * Two rules hold throughout: the access token is decrypted here and nowhere
 * else, and no Meta response body is ever returned upward. Provider errors echo
 * request parameters back and occasionally include the token itself, so they
 * are logged in category form and translated into something a salesperson can
 * act on.
 */

export type SendResult =
  | { ok: true; providerMessageId: string }
  | {
      ok: false;
      /** Safe to show a user. Never a provider body. */
      message: string;
      /**
       * Whether the message may have reached the customer despite the error.
       * A timeout is uncertain; a 400 is not. The caller uses this to decide
       * whether a retry could duplicate a customer-facing message.
       */
      uncertain: boolean;
    };

@Injectable()
export class WhatsAppOutboundService {
  private readonly logger = new Logger(WhatsAppOutboundService.name);

  constructor(private readonly config: AppConfig) {}

  /**
   * Send a text message.
   *
   * @param encryptedAccessToken as stored. Decrypted here, used once, and
   *   never returned, logged or attached to an error.
   */
  async sendText(input: {
    phoneNumberId: string;
    encryptedAccessToken: string | null;
    /** E.164 without the plus, as Meta expects. */
    recipient: string;
    body: string;
  }): Promise<SendResult> {
    if (!input.encryptedAccessToken) {
      return {
        ok: false,
        message: 'WhatsApp is not fully configured. Reconnect it in settings.',
        uncertain: false,
      };
    }

    let accessToken: string;
    try {
      const key = parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY'));
      accessToken = openSecret(input.encryptedAccessToken, key);
    } catch {
      // Wrong key, rotated key, or a tampered row. Never say which.
      this.logger.error('Stored WhatsApp credential could not be decrypted.');
      return {
        ok: false,
        message: 'WhatsApp credentials could not be read. Reconnect the channel in settings.',
        uncertain: false,
      };
    }

    const version = this.config.get('WHATSAPP_API_VERSION');
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(input.phoneNumberId)}/messages`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: input.recipient,
          type: 'text',
          // Link previews off: a preview is generated from whatever the text
          // contains, which is not something to enable by default on messages
          // a salesperson types in a hurry.
          text: { preview_url: false, body: input.body },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return this.translateFailure(response.status, await this.safeErrorCode(response));
      }

      const payload = (await response.json()) as {
        messages?: { id?: string }[];
      };

      const providerMessageId = payload.messages?.[0]?.id;

      if (!providerMessageId) {
        /*
         * Accepted, but we cannot identify what was accepted.
         *
         * Uncertain on purpose: the customer may well have received it, so a
         * retry could send a duplicate. Better to report a problem the person
         * can see than to quietly send twice.
         */
        this.logger.error('Meta accepted a WhatsApp message but returned no message id.');
        return {
          ok: false,
          message: 'The message may have been sent, but WhatsApp did not confirm it. Check before resending.',
          uncertain: true,
        };
      }

      return { ok: true, providerMessageId };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';

      this.logger.warn(
        `WhatsApp send failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );

      return {
        ok: false,
        message: timedOut
          ? 'WhatsApp did not respond in time. Check the conversation before resending.'
          : 'Could not reach WhatsApp. Please try again.',
        // A timeout means the request may have been processed. A connection
        // refused means it was not — but distinguishing them reliably is not
        // worth being wrong about, so both are treated as uncertain.
        uncertain: true,
      };
    }
  }

  /**
   * Meta's error code, if it can be read.
   *
   * Only the numeric code, never the message or the trace: those echo request
   * parameters and have been known to include the token.
   */
  private async safeErrorCode(response: Response): Promise<number | null> {
    try {
      const body = (await response.json()) as { error?: { code?: number } };
      return typeof body.error?.code === 'number' ? body.error.code : null;
    } catch {
      return null;
    }
  }

  /** Provider failures, as something a salesperson can act on. */
  private translateFailure(status: number, code: number | null): SendResult {
    this.logger.warn(`WhatsApp send rejected: HTTP ${status}, provider code ${code ?? 'none'}.`);

    if (status === 401 || status === 403) {
      return {
        ok: false,
        message: 'WhatsApp rejected the credentials. Reconnect the channel in settings.',
        uncertain: false,
      };
    }

    if (status === 429) {
      return {
        ok: false,
        message: 'WhatsApp is rate limiting messages right now. Try again shortly.',
        uncertain: false,
      };
    }

    // 131047 is Meta's "re-engagement required": the 24-hour window has closed.
    // We check the window before calling, so seeing this means our view of the
    // last inbound message disagreed with theirs.
    if (code === 131047 || code === 131051) {
      return {
        ok: false,
        message:
          'WhatsApp will not deliver a free-form reply to this customer right now. They need ' +
          'to message you again first.',
        uncertain: false,
      };
    }

    if (status >= 500) {
      return {
        ok: false,
        message: 'WhatsApp is having trouble. Please try again shortly.',
        uncertain: true,
      };
    }

    return {
      ok: false,
      message: 'WhatsApp refused the message. Please check the conversation and try again.',
      uncertain: false,
    };
  }
}
