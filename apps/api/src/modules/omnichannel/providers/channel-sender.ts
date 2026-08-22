/**
 * What the outbound path needs from any provider.
 *
 * The business service knows "send this text to this recipient on this
 * integration" and nothing else. Graph API shapes, bearer tokens, recipient
 * formats and error envelopes all live behind this boundary, which is what
 * lets one outbound flow serve three channels — and what will let a
 * non-Meta channel join later without touching the flow at all.
 */

export type SendResult =
  | { ok: true; providerMessageId: string }
  | {
      ok: false;
      /** Safe to show a user. Never a provider body. */
      message: string;
      /**
       * Whether the message may have reached the customer despite the error.
       *
       * A timeout is uncertain; a 400 is not. The caller uses this to decide
       * whether a retry could duplicate a customer-facing message — which is
       * the whole reason the distinction exists.
       */
      uncertain: boolean;
    };

export interface SendTextInput {
  /**
   * The business account the message is sent AS.
   *
   * A WhatsApp phone number id, an Instagram professional account id, or a
   * Facebook Page id. Resolved from the integration, never from a request.
   */
  accountId: string;
  /** As stored. Decrypted inside the adapter, used once, never returned. */
  encryptedAccessToken: string | null;
  /**
   * The provider-scoped identity to reply to.
   *
   * Taken from the conversation that the customer's own message opened. Never
   * derived from a phone number, an email or a display name.
   */
  recipient: string;
  body: string;
}

/** One file, already validated and held in memory for the length of a request. */
export interface SendMediaInput extends SendTextInput {
  media: {
    buffer: Buffer;
    /** The DETECTED type, never the one the browser declared. */
    mimeType: string;
    filename: string;
    /** Which of the provider's media kinds this is. */
    kind: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';
  };
  /**
   * A caption, where the provider supports one alongside media.
   *
   * WhatsApp does for images, video and documents. Messenger and Instagram do
   * not — a caption there has to be a separate message, which this phase does
   * not send on the caller's behalf.
   */
  body: string;
}

/**
 * A template send, already validated against the STORED template definition.
 *
 * No `body`: the text a template produces is fixed by the approved definition,
 * so there is nothing free-form to carry. What the customer will see is
 * rendered separately for the timeline rather than sent.
 */
export interface SendTemplateInput extends Omit<SendTextInput, 'body'> {
  template: {
    name: string;
    language: string;
    /** The parameter payload built by buildTemplateComponents. */
    components: unknown[];
  };
}

export interface ChannelSender {
  sendText(input: SendTextInput): Promise<SendResult>;
  /**
   * Send a file.
   *
   * Bytes pass through in one request: browser to LeadFlow to Meta. Nothing is
   * written to disk and nothing is stored, so there is no upload to expire, no
   * abandoned file to clean up and no new storage to operate.
   */
  sendMedia(input: SendMediaInput): Promise<SendResult>;
  /**
   * Send an approved template.
   *
   * OPTIONAL, and that is how Instagram and Messenger stay out of it: neither
   * has a template concept in its messaging API, so their adapter simply does
   * not implement this and the orchestration reports templates as unavailable
   * without needing a channel check of its own.
   */
  sendTemplate?(input: SendTemplateInput): Promise<SendResult>;
}
