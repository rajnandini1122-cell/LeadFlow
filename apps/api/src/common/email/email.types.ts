/**
 * Provider-agnostic email contract.
 *
 * The point of this file is that NOTHING in auth or invitations imports a
 * provider SDK. Business logic asks for "send this message"; which vendor
 * carries it is a deployment decision expressed in configuration.
 *
 * Adding Resend, SES or Postmark later means writing one class that implements
 * `EmailProvider` and registering it in the factory — no change to
 * PasswordResetService, InvitationsService or UsersService.
 */

export interface EmailAddress {
  email: string;
  name?: string | undefined;
}

export interface EmailMessage {
  to: EmailAddress;
  subject: string;
  /** Always required. Some clients refuse HTML, and it is the accessible form. */
  text: string;
  html: string;
  /**
   * Groups messages for observability and provider-side suppression rules,
   * e.g. 'password-reset'. Not shown to the recipient.
   */
  tag: string;
}

/**
 * What a provider reports back.
 *
 * `messageId` is provider-specific and may be absent; callers must not depend
 * on it. Delivery is asynchronous everywhere — a resolved promise means the
 * provider accepted the message, never that a human received it.
 */
export interface EmailDeliveryResult {
  accepted: boolean;
  messageId?: string | undefined;
  /**
   * Development only. Lets the local UI surface the link that would have been
   * emailed. Providers other than the console one must leave this undefined.
   */
  previewUrl?: string | undefined;
}

export interface EmailProvider {
  /** Stable identifier used in logs and health output. */
  readonly name: string;
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}

/** DI token. An interface cannot be injected by type in Nest. */
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
