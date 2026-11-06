import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';

export type UserSort = 'registered' | 'lastLogin' | 'lastActive' | 'name';

export interface UserQuery {
  search?: string | undefined;
  status?: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | undefined;
  organizationId?: string | undefined;
  registeredFrom?: Date | undefined;
  registeredTo?: Date | undefined;
  sort: UserSort;
  direction: 'asc' | 'desc';
  skip: number;
  take: number;
}

const NULLABLE_SORT = new Set<UserSort>(['lastLogin', 'lastActive']);

const SORT_FIELD: Record<UserSort, string> = {
  registered: 'createdAt',
  lastLogin: 'lastLoginAt',
  lastActive: 'lastActiveAt',
  name: 'fullName',
};

/**
 * Read queries for the CRAVION Admin "LeadFlow Analytics" module.
 *
 * Cross-tenant on purpose and therefore always under an explicit system scope
 * with a stated reason. Selects only what the dashboard shows: never password
 * hashes, tokens, session secrets, IP addresses or user agents.
 */
@Injectable()
export class AnalyticsReadsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private run<T>(reason: string, work: () => Promise<T>): Promise<T> {
    return this.tenantContext.runAsSystem(`platform analytics read: ${reason}`, work);
  }

  private get db() {
    return this.prisma.client;
  }

  async ping(): Promise<boolean> {
    return this.run('database ping', async () => {
      await this.db.analyticsCollection.findFirst({ select: { key: true } });
      return true;
    });
  }

  async collections(): Promise<{ key: string; startedAt: Date }[]> {
    return this.run('collection start dates', () => this.db.analyticsCollection.findMany());
  }

  // --- users -----------------------------------------------------------------

  async userCounts(now: Date, onlineSince: Date) {
    return this.run('user counts', async () => {
      const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
      const [total, verified, active, invited, suspended, online, new1, new7, new30, everLoggedIn] =
        await Promise.all([
          this.db.user.count(),
          this.db.user.count({ where: { emailVerifiedAt: { not: null } } }),
          this.db.user.count({ where: { status: 'ACTIVE' } }),
          this.db.user.count({ where: { status: 'INVITED' } }),
          this.db.user.count({ where: { status: 'SUSPENDED' } }),
          this.db.user.count({ where: { lastActiveAt: { gte: onlineSince } } }),
          this.db.user.count({ where: { createdAt: { gte: day(1) } } }),
          this.db.user.count({ where: { createdAt: { gte: day(7) } } }),
          this.db.user.count({ where: { createdAt: { gte: day(30) } } }),
          this.db.user.count({ where: { lastLoginAt: { not: null } } }),
        ]);
      return {
        total,
        verified,
        active,
        invited,
        suspended,
        online,
        new1,
        new7,
        new30,
        everLoggedIn,
      };
    });
  }

  /** Distinct users with any authenticated activity on or after `fromDay`. */
  async distinctActiveUsers(fromDay: Date): Promise<number> {
    return this.run(
      'distinct active users',
      async () =>
        (
          await this.db.userActivityDay.groupBy({
            by: ['userId'],
            where: { day: { gte: fromDay } },
          })
        ).length,
    );
  }

  async activeUsersByDay(fromDay: Date): Promise<{ day: Date; users: number }[]> {
    return this.run('active users by day', async () => {
      const rows = await this.db.userActivityDay.groupBy({
        by: ['day', 'userId'],
        where: { day: { gte: fromDay } },
      });
      const byDay = new Map<number, number>();
      for (const r of rows) byDay.set(r.day.getTime(), (byDay.get(r.day.getTime()) ?? 0) + 1);
      return [...byDay.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, users]) => ({ day: new Date(t), users }));
    });
  }

  async onlineUsers(onlineSince: Date) {
    return this.run('online users', () =>
      this.db.user.findMany({
        where: { lastActiveAt: { gte: onlineSince } },
        select: { id: true, fullName: true, lastActiveAt: true },
        orderBy: { lastActiveAt: 'desc' },
        take: 100,
      }),
    );
  }

  async usersPage(query: UserQuery) {
    return this.run('user list', async () => {
      const where = this.userWhere(query);
      const orderField = SORT_FIELD[query.sort];
      const [total, users] = await Promise.all([
        this.db.user.count({ where }),
        this.db.user.findMany({
          where,
          // `nulls` is only valid on nullable columns (last login / last active).
          orderBy: [
            NULLABLE_SORT.has(query.sort)
              ? { [orderField]: { sort: query.direction, nulls: 'last' } }
              : { [orderField]: query.direction },
            { id: 'asc' },
          ],
          skip: query.skip,
          take: query.take,
          select: {
            id: true,
            fullName: true,
            email: true,
            status: true,
            emailVerifiedAt: true,
            createdAt: true,
            firstLoginAt: true,
            lastLoginAt: true,
            lastActiveAt: true,
            memberships: {
              select: {
                status: true,
                role: { select: { key: true } },
                organization: { select: { id: true, name: true } },
              },
            },
            _count: {
              select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } },
            },
          },
        }),
      ]);
      return { total, users };
    });
  }

  private userWhere(query: UserQuery): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (query.search) {
      where['OR'] = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search.toLowerCase() } },
      ];
    }
    if (query.status) where['status'] = query.status;
    if (query.organizationId)
      where['memberships'] = { some: { organizationId: query.organizationId } };
    if (query.registeredFrom || query.registeredTo) {
      where['createdAt'] = {
        ...(query.registeredFrom ? { gte: query.registeredFrom } : {}),
        ...(query.registeredTo ? { lt: query.registeredTo } : {}),
      };
    }
    return where;
  }

  async registrationsSince(from: Date) {
    return this.run('registrations over time', async () => {
      const [users, organizations] = await Promise.all([
        this.db.user.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true } }),
        this.db.organization.findMany({
          where: { createdAt: { gte: from } },
          select: { createdAt: true },
        }),
      ]);
      return {
        users: users.map((u) => u.createdAt),
        organizations: organizations.map((o) => o.createdAt),
      };
    });
  }

  // --- organizations -----------------------------------------------------------

  async organizations(monthStart: Date) {
    return this.run('organizations', async () => {
      const [orgs, lastActivity, newThisMonth] = await Promise.all([
        this.db.organization.findMany({
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
          },
          orderBy: { createdAt: 'asc' },
        }),
        this.db.userActivityDay.groupBy({ by: ['organizationId'], _max: { firstSeenAt: true } }),
        this.db.organization.count({ where: { createdAt: { gte: monthStart } } }),
      ]);
      return { orgs, lastActivity, newThisMonth };
    });
  }

  async sessionCounts(now: Date) {
    return this.run('session counts', async () => {
      const live = { revokedAt: null, expiresAt: { gt: now } };
      const [byPlatform, users] = await Promise.all([
        this.db.session.groupBy({ by: ['platform'], where: live, _count: { _all: true } }),
        this.db.session.groupBy({ by: ['userId'], where: live }),
      ]);
      return {
        byPlatform: byPlatform.map((r) => ({ platform: r.platform, sessions: r._count._all })),
        usersWithSession: users.length,
      };
    });
  }

  // --- API metrics ---------------------------------------------------------------

  async apiRows(from: Date, to: Date) {
    return this.run('API metrics', () =>
      this.db.apiMetricHour.findMany({ where: { hour: { gte: from, lt: to } } }),
    );
  }

  async orgApiRows(from: Date, to: Date) {
    return this.run('API usage by organization', async () => {
      const rows = await this.db.apiOrganizationHour.groupBy({
        by: ['organizationId'],
        where: { hour: { gte: from, lt: to } },
        _sum: { count: true, errorCount: true },
      });
      const names = await this.db.organization.findMany({
        where: { id: { in: rows.map((r) => r.organizationId) } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(names.map((n) => [n.id, n.name]));
      return rows.map((r) => ({
        organizationId: r.organizationId,
        name: nameOf.get(r.organizationId) ?? '(deleted organization)',
        requests: r._sum.count ?? 0,
        errors: r._sum.errorCount ?? 0,
      }));
    });
  }

  // --- public website ----------------------------------------------------------

  async webSessions(fromDay: Date, toDay: Date) {
    return this.run('website sessions', () =>
      this.db.webSession.findMany({
        where: { day: { gte: fromDay, lt: toDay } },
        select: {
          visitorHash: true,
          day: true,
          landingPath: true,
          source: true,
          referrerDomain: true,
          pageViews: true,
          returning: true,
        },
      }),
    );
  }

  async webPageViews(fromDay: Date, toDay: Date) {
    return this.run('website page views', () =>
      this.db.webPageDay.findMany({ where: { day: { gte: fromDay, lt: toDay } } }),
    );
  }

  async webEvents(fromDay: Date, toDay: Date) {
    return this.run('website events', () =>
      this.db.webEventDay.findMany({ where: { day: { gte: fromDay, lt: toDay } } }),
    );
  }

  // --- audit -------------------------------------------------------------------

  async analyticsAudit(take: number) {
    return this.run('analytics access audit', () =>
      this.db.auditLog.findMany({
        where: { action: { startsWith: 'platform.analytics.' } },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, action: true, externalActorRef: true, after: true, createdAt: true },
      }),
    );
  }
}
