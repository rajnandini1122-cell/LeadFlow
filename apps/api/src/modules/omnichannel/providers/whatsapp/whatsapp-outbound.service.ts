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

@Injectable()
export class WhatsAppOutboundService implements ChannelSender {
  private readonly logger = new Logger(WhatsAppOutboundService.name);

  constructor(private readonly config: AppConfig) {}

  /**
   * Send a text message.
   *
   * @param encryptedAccessToken as stored. Decrypted here, used once, and
   *   never returned, logged or attached to an error.
   */
  async sendText(input: SendTextInput): Promise<SendResult> {
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
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(input.accountId)}/messages`;

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
          // Meta wants E.164 digits with no plus. Normalised HERE rather than
          // by the caller, because it is a WhatsApp addressing rule and no
          // other channel shares it.
          to: input.recipient.replace(/^\+/, ''),
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
   * Send a file.
   *
   * WhatsApp takes two calls: upload the bytes to get a media id, then send a
   * message referencing it. That split is what makes the failure handling
   * interesting — an upload that succeeds followed by a send that times out
   * leaves a media id Meta holds and we cannot use, which is wasteful but
   * harmless. A send that times out AFTER being accepted is the dangerous one,
   * and it is reported as uncertain so nothing resends it automatically.
   */
  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    const credentials = await this.credentials(input.encryptedAccessToken);
    if (!credentials.ok) return credentials.failure;

    const { accessToken, version } = credentials;

    // --- step one: upload the bytes ----------------------------------------
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', input.media.mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(input.media.buffer)], { type: input.media.mimeType }),
      input.media.filename,
    );

    let mediaId: string;
    try {
      const upload = await fetch(
        `https://graph.facebook.com/${version}/${encodeURIComponent(input.accountId)}/media`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: form,
          signal: AbortSignal.timeout(60_000),
        },
      );

      if (!upload.ok) {
        return this.translateFailure(upload.status, await this.safeErrorCode(upload));
      }

      const payload = (await upload.json()) as { id?: string };
      if (!payload.id) {
        this.logger.error('WhatsApp accepted a media upload but returned no id.');
        return {
          ok: false,
          message: 'WhatsApp did not accept the file. Please try again.',
          // Nothing was SENT — only uploaded — so a retry cannot duplicate a
          // customer-facing message.
          uncertain: false,
        };
      }

      mediaId = payload.id;
    } catch (error) {
      this.logger.warn(
        `WhatsApp media upload failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return {
        ok: false,
        message: 'Could not upload the file to WhatsApp. Please try again.',
        // An upload never reaches the customer, so this is safe to retry.
        uncertain: false,
      };
    }

    // --- step two: send the message ----------------------------------------
    const kind = input.media.kind.toLowerCase();
    const media: Record<string, unknown> = { id: mediaId };

    // Captions are supported for image, video and document — not audio.
    if (input.body && kind !== 'audio') media['caption'] = input.body;
    if (kind === 'document') media['filename'] = input.media.filename;

    return this.post(
      `https://graph.facebook.com/${version}/${encodeURIComponent(input.accountId)}/messages`,
      accessToken,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.recipient.replace(/^\+/, ''),
        type: kind,
        [kind]: media,
      },
    );
  }

  /** Decrypts once, for either send path. */
  private async credentials(
    encryptedAccessToken: string | null,
  ): Promise<
    { ok: true; accessToken: string; version: string } | { ok: false; failure: SendResult }
  > {
    if (!encryptedAccessToken) {
      return {
        ok: false,
        failure: {
          ok: false,
          message: 'WhatsApp is not fully configured. Reconnect it in settings.',
          uncertain: false,
        },
      };
    }

    try {
      const key = parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY'));
      return {
        ok: true,
        accessToken: openSecret(encryptedAccessToken, key),
        version: this.config.get('WHATSAPP_API_VERSION'),
      };
    } catch {
      this.logger.error('Stored WhatsApp credential could not be decrypted.');
      return {
        ok: false,
        failure: {
          ok: false,
          message: 'WhatsApp credentials could not be read. Reconnect the channel in settings.',
          uncertain: false,
        },
      };
    }
  }

  /** The shared send call, used by text and by the second half of media. */
  private async post(
    url: string,
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<SendResult> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return this.translateFailure(response.status, await this.safeErrorCode(response));
      }

      const payload = (await response.json()) as { messages?: { id?: string }[] };
      const providerMessageId = payload.messages?.[0]?.id;

      if (!providerMessageId) {
        this.logger.error('Meta accepted a WhatsApp message but returned no message id.');
        return {
          ok: false,
          message:
            'The message may have been sent, but WhatsApp did not confirm it. Check before resending.',
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
