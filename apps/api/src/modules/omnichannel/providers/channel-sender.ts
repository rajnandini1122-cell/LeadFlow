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

export interface ChannelSender {
  sendText(input: SendTextInput): Promise<SendResult>;
}
