import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'node:crypto';
import {
  classifyFcmError,
  type PushMessage,
  type PushProvider,
  type PushResult,
} from './push-provider';

/**
 * Firebase Cloud Messaging, over HTTP v1.
 *
 * Deliberately the REST API and node:crypto rather than `firebase-admin`. The
 * SDK is a large dependency whose behaviour cannot be verified here without
 * live credentials, and everything it would do for this use case is one signed
 * JWT and one POST. Behind the PushProvider interface, swapping to the SDK
 * later is a single class — which is precisely what the interface is for.
 *
 * SECURITY: the service-account private key lives in server configuration and
 * NEVER reaches the APK. A mobile client holds only its own device token, which
 * lets it receive messages and not send them. Nothing in this file is ever
 * shipped to a client.
 */
@Injectable()
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';

  private readonly logger = new Logger(FcmPushProvider.name);

  /**
   * The OAuth2 access token, cached until shortly before it expires.
   *
   * Google issues one-hour tokens. Re-minting per message would add a network
   * round trip and an RSA signature to every notification; the 60-second margin
   * means a token is never used in the window where it might expire in flight.
   */
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: {
      projectId: string | undefined;
      clientEmail: string | undefined;
      privateKey: string | undefined;
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.credentials.projectId && this.credentials.clientEmail && this.credentials.privateKey,
    );
  }

  /**
   * Sends messages, one HTTP call each.
   *
   * FCM HTTP v1 has no true batch endpoint — the old batch API is retired — so
   * this fans out with bounded concurrency rather than pretending otherwise.
   *
   * Never throws for a per-message failure. Every message produces a result,
   * because one dead token must not stop delivery to the user's other devices.
   */
  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (!this.isConfigured()) {
      return messages.map((message) => ({
        token: message.token,
        success: false,
        failure: 'PERMANENT' as const,
        reason: 'FCM is not configured',
      }));
    }

    let token: string;
    try {
      token = await this.authorize();
    } catch (error) {
      /*
       * Credentials failed. Every message fails the same way, and it is
       * PERMANENT rather than transient: retrying sends the same bad
       * credentials and the queue would grind forever.
       */
      this.logger.error({ err: error }, 'Could not obtain an FCM access token');
      return messages.map((message) => ({
        token: message.token,
        success: false,
        failure: 'PERMANENT' as const,
        reason: 'authorization failed',
      }));
    }

    const results: PushResult[] = [];

    // Small batches. Bounded so a user with many devices cannot open dozens of
    // simultaneous sockets, and so a slow provider degrades rather than stalls.
    const CONCURRENCY = 5;
    for (let index = 0; index < messages.length; index += CONCURRENCY) {
      const slice = messages.slice(index, index + CONCURRENCY);
      const settled = await Promise.all(slice.map((message) => this.sendOne(message, token)));
      results.push(...settled);
    }

    return results;
  }

  private async sendOne(message: PushMessage, accessToken: string): Promise<PushResult> {
    const url = `https://fcm.googleapis.com/v1/projects/${this.credentials.projectId}/messages:send`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: { title: message.title, body: message.body },
            /*
             * Data values must be strings in FCM. Nulls are omitted rather than
             * stringified — "null" as a routing id would send the client to a
             * screen for a record that does not exist.
             */
            data: Object.fromEntries(
              Object.entries(message.data).filter(
                (entry): entry is [string, string] => entry[1] !== null,
              ),
            ),
            android: {
              priority: 'HIGH',
              notification: {
                // Tapping opens the app and hands the payload to the deep-link
                // handler rather than just raising the last screen.
                clickAction: 'FLUTTER_NOTIFICATION_CLICK',
              },
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        return { token: message.token, success: true };
      }

      const detail = (await response.json().catch(() => null)) as {
        error?: { status?: string; message?: string };
      } | null;

      const errorCode = detail?.error?.status;

      return {
        token: message.token,
        success: false,
        failure: classifyFcmError({ statusCode: response.status, errorCode }),
        /*
         * The provider's own message, NOT the request. FCM error text can echo
         * the request back, and the request contains the device token.
         */
        reason: errorCode ?? `HTTP ${response.status}`,
      };
    } catch (error) {
      // Network failure or timeout. The token is fine; the world was not.
      return {
        token: message.token,
        success: false,
        failure: 'TRANSIENT',
        reason: error instanceof Error ? error.name : 'network error',
      };
    }
  }

  /**
   * A Google OAuth2 access token, from a service-account JWT.
   *
   * The standard two-legged flow: sign a short-lived assertion with the
   * service account's private key, exchange it for a bearer token. Cached,
   * because the signature is an RSA operation and the exchange is a network
   * round trip — neither belongs on the path of every notification.
   */
  private async authorize(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.value;
    }

    const assertion = this.signAssertion();

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Deliberately does not include the response body: a failed token
      // exchange can echo the assertion, which is signed with the private key.
      throw new Error(`Token exchange failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };

    this.accessToken = {
      value: body.access_token,
      // 60 seconds of margin, so a token is never used in the window where it
      // could expire mid-flight.
      expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    };

    return body.access_token;
  }

  /** The signed JWT assertion. RS256, as the flow requires. */
  private signAssertion(): string {
    const now = Math.floor(Date.now() / 1000);

    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({
        iss: this.credentials.clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        // One hour is the maximum Google accepts.
        exp: now + 3600,
      }),
    );

    const signingInput = `${header}.${claims}`;

    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);

    /*
     * Environment variables cannot carry real newlines, so a PEM key is
     * conventionally stored with them escaped. Restoring them is required or
     * the key does not parse — and the failure is an opaque crypto error rather
     * than anything that names the cause.
     */
    const privateKey = (this.credentials.privateKey ?? '').replace(/\\n/g, '\n');

    const signature = signer.sign(privateKey, 'base64');

    return `${signingInput}.${toBase64Url(signature)}`;
  }
}

function base64Url(value: string): string {
  return toBase64Url(Buffer.from(value).toString('base64'));
}

function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The provider used when FCM is not configured.
 *
 * Reports every message as a PERMANENT failure rather than pretending to
 * succeed. That matters: a silent no-op would make an unconfigured production
 * deployment look healthy while no salesperson ever received anything, and the
 * metrics would agree with it.
 *
 * The notification itself is still persisted and still appears in the bell, so
 * an unconfigured environment degrades to in-app only rather than losing work.
 */
@Injectable()
export class UnconfiguredPushProvider implements PushProvider {
  readonly name = 'unconfigured';

  isConfigured(): boolean {
    return false;
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    return messages.map((message) => ({
      token: message.token,
      success: false,
      failure: 'PERMANENT' as const,
      reason: 'no push provider configured',
    }));
  }
}
