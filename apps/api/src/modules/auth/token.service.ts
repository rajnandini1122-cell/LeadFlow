import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '../../common/utils/uuid';
import type { RoleKey } from '@idea001/api-types';
import { AppConfig } from '../../common/config/config.module';
import { RedisService } from '../../common/redis/redis.service';
import { AppException } from '../../common/errors/app.exception';

/**
 * Access-token claims.
 *
 * `org` arrives on every request inside a server-signed JWT. That signature is
 * what makes it trustworthy — it is not "client-supplied data" in the sense
 * §4 warns about, because the client cannot forge it. It is still re-validated
 * against a live membership record on every request (see JwtAuthGuard), so a
 * revoked user cannot ride out the remaining token lifetime.
 */
export interface AccessTokenClaims {
  sub: string;
  org: string;
  role: RoleKey;
  /** Session id — ties the access token to a refresh-token family. */
  sid: string;
  /** Token id — the deny-list key, so logout is immediate. */
  jti: string;
}

export interface IssuedRefreshToken {
  /** Returned to the client exactly once; never persisted in this form. */
  token: string;
  /** What actually goes in the database. */
  hash: string;
  expiresAt: Date;
}

const DENY_LIST_PREFIX = 'denylist:jti:';

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  // --- access tokens --------------------------------------------------------

  async issueAccessToken(claims: Omit<AccessTokenClaims, 'jti'>): Promise<{
    token: string;
    jti: string;
    expiresIn: number;
  }> {
    const jti = uuidv7();
    const ttl = this.config.get('JWT_ACCESS_TTL');

    const token = await this.jwt.signAsync(
      { ...claims, jti },
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        // jsonwebtoken types expiresIn as a `ms` StringValue template literal.
        // The env schema already guarantees the `\d+[smhd]` shape, so the cast
        // asserts something that has genuinely been validated.
        expiresIn: ttl as `${number}${'s' | 'm' | 'h' | 'd'}`,
      },
    );

    return { token, jti, expiresIn: parseDurationSeconds(ttl) };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    let claims: AccessTokenClaims;

    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      });
    } catch (error) {
      if ((error as Error).name === 'TokenExpiredError') throw AppException.tokenExpired();
      throw AppException.tokenInvalid();
    }

    if (!claims.sub || !claims.org || !claims.sid || !claims.jti) {
      throw AppException.tokenInvalid();
    }

    if (await this.isDenied(claims.jti)) throw AppException.tokenInvalid();

    return claims;
  }

  /**
   * Revokes a still-valid access token.
   *
   * The entry expires when the token would have expired anyway, so the deny
   * list stays bounded no matter how many logouts occur.
   */
  async denyAccessToken(jti: string, expiresAtEpochSeconds?: number): Promise<void> {
    const remaining = expiresAtEpochSeconds
      ? Math.max(1, expiresAtEpochSeconds - Math.floor(Date.now() / 1000))
      : parseDurationSeconds(this.config.get('JWT_ACCESS_TTL'));

    await this.redis.client.set(`${DENY_LIST_PREFIX}${jti}`, '1', 'EX', remaining).catch(() => {
      // A Redis outage must not prevent logout from revoking the refresh token,
      // which is the durable half of the revocation.
      this.logger.warn(`Could not deny-list jti ${jti}; refresh token still revoked`);
    });
  }

  private async isDenied(jti: string): Promise<boolean> {
    try {
      return (await this.redis.client.exists(`${DENY_LIST_PREFIX}${jti}`)) === 1;
    } catch {
      // Fail OPEN here, deliberately. The token's signature and expiry are
      // still checked, and the membership lookup still runs against Postgres.
      // Failing closed would turn a Redis blip into a total outage.
      return false;
    }
  }

  // --- refresh tokens -------------------------------------------------------

  /**
   * Refresh tokens are opaque 256-bit random values, not JWTs.
   *
   * There is nothing to read in them, so they cannot leak claims, and because
   * only a SHA-256 hash is stored, a database disclosure does not yield usable
   * tokens. SHA-256 rather than argon2 is correct here: the input is 256 bits
   * of entropy, so there is no dictionary to defend against, and refresh
   * happens often enough that a deliberately slow hash would hurt.
   */
  issueRefreshToken(): IssuedRefreshToken {
    const token = randomBytes(32).toString('base64url');
    const ttlSeconds = parseDurationSeconds(this.config.get('JWT_REFRESH_TTL'));

    return {
      token,
      hash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  hashRefreshToken(token: string): string {
    return hashRefreshToken(token);
  }

  /** Constant-time compare, for the rare places a direct comparison is needed. */
  safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Converts "15m" / "24h" / "30d" to seconds. Validated by the env schema. */
export function parseDurationSeconds(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new Error(`Invalid duration: ${duration}`);

  const value = Number(match[1]);
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[match[2] as string] as number);
}
