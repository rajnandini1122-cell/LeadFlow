import { Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';

/**
 * Verifying a Google sign-in.
 *
 * The browser sends an ID token it got from Google. This checks it is genuine
 * and returns what Google says about the person — nothing more. Everything
 * about sessions, organizations and membership stays where it already lives.
 *
 * Three rules do the security work here, and each of them is the difference
 * between a convenience and an account-takeover route:
 *
 *   1. The token is verified against GOOGLE'S OWN KEYS, with our client id as
 *      the expected audience. Decoding the payload without verifying would
 *      accept anything a caller cared to type — the whole point of the token
 *      is its signature.
 *
 *   2. `email_verified` must be true. Google will issue a token for an
 *      unverified address on some account types, and an unverified address is
 *      a claim rather than a fact. Trusting it would let somebody register a
 *      Google account against a victim's email and inherit their LeadFlow
 *      account.
 *
 *   3. The email is matched EXACTLY as Google normalises it. Nothing is
 *      lowercased, trimmed or dot-stripped here beyond what the rest of the
 *      application already does, because two different normalisations meeting
 *      in the middle is how one person's address matches another's row.
 */

export interface GoogleIdentity {
  /** Google's stable id for the account. Never reused, unlike an email. */
  subject: string;
  email: string;
  fullName: string | null;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private client: OAuth2Client | null = null;

  constructor(private readonly config: AppConfig) {}

  /**
   * Whether Google sign-in is available on this deployment.
   *
   * Read by the client so the button appears only where it can actually work.
   * A Google button that fails on click is worse than no button: it looks like
   * the product is broken rather than not configured.
   */
  get enabled(): boolean {
    return Boolean(this.clientId);
  }

  private get clientId(): string | undefined {
    return this.config.get('GOOGLE_CLIENT_ID') ?? undefined;
  }

  /**
   * Checks the token and returns who Google says this is.
   *
   * Throws for anything that is not a verified, current token issued to this
   * application. The failure message is deliberately the same for every cause:
   * a caller probing with forged tokens learns nothing about which part was
   * wrong.
   */
  async verify(idToken: string): Promise<GoogleIdentity> {
    const clientId = this.clientId;

    if (!clientId) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'Google sign-in is not configured on this deployment.',
        409,
      );
    }

    this.client ??= new OAuth2Client(clientId);

    let payload;
    try {
      /*
       * `verifyIdToken` checks the signature against Google's published keys,
       * the issuer, the expiry, and that the audience is OUR client id. That
       * last part matters: a token minted for a different application is a
       * perfectly valid Google token and must still be refused here.
       */
      const ticket = await this.client.verifyIdToken({ idToken, audience: clientId });
      payload = ticket.getPayload();
    } catch (error) {
      // Category only. The token is a credential and must not be logged, and
      // the reason is not something a caller should be able to probe for.
      this.logger.warn(
        `Google ID token rejected: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      throw AppException.unauthorized('Google sign-in failed. Please try again.');
    }

    if (!payload?.sub || !payload.email) {
      throw AppException.unauthorized('Google sign-in failed. Please try again.');
    }

    if (payload.email_verified !== true) {
      /*
       * The one refusal worth its own message.
       *
       * An unverified address is a claim, not a fact. Accepting it would let
       * somebody create a Google account against an address they do not
       * control and be handed the LeadFlow account that belongs to it.
       */
      throw AppException.unauthorized(
        'Your Google account email is not verified. Verify it with Google and try again.',
      );
    }

    return {
      subject: payload.sub,
      email: payload.email,
      fullName: payload.name ?? null,
    };
  }
}
