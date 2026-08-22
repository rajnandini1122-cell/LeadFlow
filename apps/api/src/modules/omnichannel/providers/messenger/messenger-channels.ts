import type { ChannelType } from '../../../../generated/prisma/enums';

/**
 * The two channels that speak Meta's Messenger protocol.
 *
 * Instagram Direct and Facebook Messenger are the same wire format: the same
 * `entry[].messaging[]` envelope, the same millisecond timestamps, the same
 * echo semantics, the same HMAC. They differ in four values, and those four
 * values are what this file holds.
 *
 * Written as data rather than as two implementations because the alternative
 * was ~800 lines of near-identical provider code per channel. Duplication at
 * that scale does not stay identical — one copy gets a fix and the other does
 * not, and the way you find out is a webhook that verifies nothing while its
 * sibling looks fine.
 *
 * WhatsApp is deliberately NOT here. It uses a different envelope entirely,
 * and it sends and tracks delivery, so folding it in would mean a descriptor
 * full of fields only one channel uses.
 */

/** Config keys, kept as literals so a typo fails at compile time. */
export type MetaSecretKey = 'INSTAGRAM_APP_SECRET' | 'FACEBOOK_APP_SECRET';
export type MetaVerifyKey = 'INSTAGRAM_VERIFY_TOKEN' | 'FACEBOOK_VERIFY_TOKEN';

export interface MessengerChannelConfig {
  channel: ChannelType;
  /** How the channel is named in logs and in messages people read. */
  label: string;
  /**
   * Meta's `object` field on the webhook envelope.
   *
   * Checked before anything else is read: the two endpoints are separately
   * configured at Meta, and an Instagram payload arriving on the Facebook one
   * means something is misconfigured, not that it should be ingested.
   */
  webhookObject: string;
  appSecretKey: MetaSecretKey;
  verifyTokenKey: MetaVerifyKey;

  /** Graph API fields read back to prove the credentials work. */
  validationFields: string;
  /** Turns a successful validation response into a display name. */
  displayName: (payload: Record<string, unknown>) => string | null;
  /**
   * Setup guidance, per provider.
   *
   * The failures are the same shapes but the fixes are not: an Instagram
   * account has to be professional and linked to a Page, whereas a Facebook
   * Page needs the app subscribed to it.
   */
  setupErrors: {
    unauthorized: string;
    notFound: string;
    noDetails: string;
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const INSTAGRAM_CHANNEL: MessengerChannelConfig = {
  channel: 'INSTAGRAM',
  label: 'Instagram',
  webhookObject: 'instagram',
  appSecretKey: 'INSTAGRAM_APP_SECRET',
  verifyTokenKey: 'INSTAGRAM_VERIFY_TOKEN',
  validationFields: 'username,name',
  displayName: (payload) => {
    const username = asString(payload['username']);
    return username ? `@${username}` : (asString(payload['name']) ?? null);
  },
  setupErrors: {
    unauthorized:
      'Instagram rejected the access token. Check it has not expired and that the app has ' +
      'instagram_manage_messages permission.',
    notFound:
      'Meta does not recognise that Instagram account id for this token. Check the account is ' +
      'a professional account linked to the connected Facebook Page.',
    noDetails: 'Instagram did not return account details for that id. Check the account type.',
  },
};

export const FACEBOOK_CHANNEL: MessengerChannelConfig = {
  channel: 'FACEBOOK',
  label: 'Facebook Messenger',
  // Messenger webhooks arrive as `page`, not `facebook`.
  webhookObject: 'page',
  appSecretKey: 'FACEBOOK_APP_SECRET',
  verifyTokenKey: 'FACEBOOK_VERIFY_TOKEN',
  validationFields: 'name',
  displayName: (payload) => asString(payload['name']) ?? null,
  setupErrors: {
    unauthorized:
      'Facebook rejected the page access token. Check it has not expired and that the app has ' +
      'pages_messaging permission.',
    notFound:
      'Meta does not recognise that Page id for this token. Check the token is a Page access ' +
      'token for that exact Page.',
    noDetails: 'Facebook did not return details for that Page. Check the Page id.',
  },
};
