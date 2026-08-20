import { Injectable } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';
import { AuthRepository, type MembershipRecord } from './auth.repository';

/**
 * Caches the membership record consulted on every authenticated request.
 *
 * The trade-off being managed here is revocation latency versus database load.
 * Putting the role in the JWT alone would mean a suspended user keeps working
 * until their access token expires. Reading Postgres on every request is
 * correct but wasteful. A short-lived cache with explicit invalidation on every
 * mutating path gives near-immediate revocation and one database read per user
 * per minute.
 *
 * A Redis outage degrades to reading Postgres directly — slower, still correct.
 * It never degrades to "assume still authorised".
 */
@Injectable()
export class MembershipCacheService {
  private static readonly TTL_SECONDS = 60;

  constructor(
    private readonly redis: RedisService,
    private readonly repository: AuthRepository,
  ) {}

  private key(userId: string, organizationId: string): string {
    return `membership:${organizationId}:${userId}`;
  }

  async get(userId: string, organizationId: string): Promise<MembershipRecord | null> {
    const cached = await this.redis.getJson<MembershipRecord>(this.key(userId, organizationId));
    if (cached) return cached;

    const fresh = await this.repository.findMembership(userId, organizationId);
    if (fresh) {
      await this.redis.setJson(
        this.key(userId, organizationId),
        fresh,
        MembershipCacheService.TTL_SECONDS,
      );
    }
    return fresh;
  }

  /**
   * Must be called by every path that changes a user's role, status, or
   * membership. Missing one means a stale grant survives for up to a minute.
   */
  async invalidate(userId: string, organizationId: string): Promise<void> {
    await this.redis.del(this.key(userId, organizationId));
  }
}
