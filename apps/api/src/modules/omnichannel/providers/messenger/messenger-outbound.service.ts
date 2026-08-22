import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../../common/config/config.module';
import { openSecret, parseEncryptionKey } from '../../../../common/crypto/secret-box';
import type {
  ChannelSender,
  SendMediaInput,
  SendResult,
  SendTextInput,
} from '../channel-sender';

/**
 * Sending on Instagram Direct and Facebook Messenger.
 *
 * One adapter for both, because the Send API is the same call: a POST to the
 * business account's `/messages` node with a recipient id and a text body. The
 * only thing that differs is which account id sits in the path, and that comes
 * from the integration.
 *
 * Two rules hold throughout, as in the WhatsApp adapter: the access token is
 * decrypted here and nowhere else, and no Meta response body is ever returned
 * upward. Provider errors echo request parameters back and occasionally include
 * the token, so they are logged in category form and translated into something
 * a salesperson can act on.
 */
@Injectable()
export class MessengerOutboundService implements ChannelSender {
  private readonly logger = new Logger(MessengerOutboundService.name);

  constructor(private readonly config: AppConfig) {}

  async sendText(input: SendTextInput): Promise<SendResult> {
    if (!input.encryptedAccessToken) {
      return {
        ok: false,
        message: 'This channel is not fully configured. Reconnect it in settings.',
        uncertain: false,
      };
    }

    let accessToken: string;
    try {
      const key = parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY'));
      accessToken = openSecret(input.encryptedAccessToken, key);
    } catch {
      // Wrong key, rotated key, or a tampered row. Never say which.
      this.logger.error('Stored Messenger credential could not be decrypted.');
      return {
        ok: false,
        message: 'Credentials could not be read. Reconnect the channel in settings.',
        uncertain: false,
      };
    }

    const version = this.config.get('WHATSAPP_API_VERSION');
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(input.accountId)}/messages`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          /*
           * RESPONSE, not UPDATE or MESSAGE_TAG.
           *
           * This declares the message as a reply inside the 24-hour window,
           * which is the only thing LeadFlow sends. The window is enforced
           * before we get here; declaring it honestly means Meta refuses
           * rather than silently reclassifying if our view ever disagrees
           * with theirs.
           */
          messaging_type: 'RESPONSE',
          recipient: { id: input.recipient },
          message: { text: input.body },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return this.translateFailure(response.status, await this.safeErrorCode(response));
      }

      const payload = (await response.json()) as { message_id?: string; recipient_id?: string };
      const providerMessageId = payload.message_id;

      if (!providerMessageId) {
        /*
         * Accepted, but we cannot identify what was accepted.
         *
         * Uncertain on purpose: the customer may well have received it, so a
         * retry could send a duplicate. Better to report a problem the person
         * can see than to quietly send twice.
         */
        this.logger.error('Meta accepted a Messenger message but returned no message id.');
        return {
          ok: false,
          message:
            'The message may have been sent, but Meta did not confirm it. Check before resending.',
          uncertain: true,
        };
      }

      return { ok: true, providerMessageId };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';

      this.logger.warn(
        `Messenger send failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );

      return {
        ok: false,
        message: timedOut
          ? 'Meta did not respond in time. Check the conversation before resending.'
          : 'Could not reach Meta. Please try again.',
        // A timeout means the request may have been processed. Both cases are
        // treated as uncertain rather than being wrong about which is which.
        uncertain: true,
      };
    }
  }

  /**
   * Send a file.
   *
   * Messenger and Instagram take ONE call: the file and the message go up
   * together as multipart, with the recipient and a typed attachment
   * descriptor alongside. Unlike WhatsApp there is no separate upload step,
   * which means there is no half-finished state to reason about — it either
   * reached the customer or it did not.
   *
   * No caption. Neither channel accepts text alongside an attachment in one
   * message, and sending a second message on the caller's behalf would be
   * inventing traffic they did not ask for.
   */
  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    if (!input.encryptedAccessToken) {
      return {
        ok: false,
        message: 'This channel is not fully configured. Reconnect it in settings.',
        uncertain: false,
      };
    }

    let accessToken: string;
    try {
      const key = parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY'));
      accessToken = openSecret(input.encryptedAccessToken, key);
    } catch {
      this.logger.error('Stored Messenger credential could not be decrypted.');
      return {
        ok: false,
        message: 'Credentials could not be read. Reconnect the channel in settings.',
        uncertain: false,
      };
    }

    const version = this.config.get('WHATSAPP_API_VERSION');
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(input.accountId)}/messages`;

    const form = new FormData();
    form.append('messaging_type', 'RESPONSE');
    form.append('recipient', JSON.stringify({ id: input.recipient }));
    form.append(
      'message',
      JSON.stringify({
        attachment: {
          type: input.media.kind.toLowerCase(),
          payload: { is_reusable: false },
        },
      }),
    );
    form.append(
      'filedata',
      new Blob([new Uint8Array(input.media.buffer)], { type: input.media.mimeType }),
      input.media.filename,
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        return this.translateFailure(response.status, await this.safeErrorCode(response));
      }

      const payload = (await response.json()) as { message_id?: string };
      const providerMessageId = payload.message_id;

      if (!providerMessageId) {
        this.logger.error('Meta accepted a Messenger attachment but returned no message id.');
        return {
          ok: false,
          message:
            'The file may have been sent, but Meta did not confirm it. Check before resending.',
          uncertain: true,
        };
      }

      return { ok: true, providerMessageId };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      this.logger.warn(
        `Messenger media send failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );

      return {
        ok: false,
        message: timedOut
          ? 'Meta did not respond in time. Check the conversation before resending.'
          : 'Could not reach Meta. Please try again.',
        /*
         * Uncertain, and that matters more for media than for text.
         *
         * The file and the send are one call here, so a timeout genuinely may
         * have delivered it. A duplicate photo is more jarring to a customer
         * than a duplicate sentence, which is exactly why nothing retries on
         * its own.
         */
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
    this.logger.warn(`Messenger send rejected: HTTP ${status}, provider code ${code ?? 'none'}.`);

    if (status === 401 || status === 403) {
      return {
        ok: false,
        message: 'Meta rejected the credentials. Reconnect the channel in settings.',
        uncertain: false,
      };
    }

    if (status === 429) {
      return {
        ok: false,
        message: 'Meta is rate limiting messages right now. Try again shortly.',
        uncertain: false,
      };
    }

    /*
     * 10 and 613 are Meta's "outside the allowed messaging window" family.
     *
     * The window is checked before sending, so seeing this means our view of
     * the customer's last message disagreed with theirs — worth saying plainly
     * rather than reporting as a generic refusal.
     */
    if (code === 10 || code === 613 || code === 2018278) {
      return {
        ok: false,
        message:
          'Meta will not deliver a reply to this customer right now. They need to message you ' +
          'again first.',
        uncertain: false,
      };
    }

    // 100 with a bad recipient is the usual "this person cannot be messaged".
    if (status === 400) {
      return {
        ok: false,
        message: 'Meta refused the message. The customer may have blocked or deleted the chat.',
        uncertain: false,
      };
    }

    if (status >= 500) {
      return {
        ok: false,
        message: 'Meta is having trouble. Please try again shortly.',
        uncertain: true,
      };
    }

    return {
      ok: false,
      message: 'Meta refused the message. Please check the conversation and try again.',
      uncertain: false,
    };
  }
}
