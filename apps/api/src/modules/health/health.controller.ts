import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import type { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
// Deliberate exception to the repository-only Prisma rule. The readiness probe
// calls PrismaService.ping(), which runs on the UNEXTENDED client against a
// non-tenant table — there is no tenant context on a probe, and there is no
// repository this could sensibly live behind.
// eslint-disable-next-line no-restricted-imports
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { MetricsService } from '../../common/observability/metrics.service';
import { Public } from '../auth/decorators/public.decorator';
import { raw } from '../../common/interceptors/response-envelope.interceptor';
import { withTimeout } from '../../common/utils/with-timeout';

/**
 * Two endpoints with genuinely different jobs (spec §28):
 *
 *   /health    — "is this process alive?" Never touches a dependency. An
 *                orchestrator restarting the pod because Redis blipped would
 *                turn a degraded dependency into an outage.
 *   /readiness — "should this process receive traffic?" Checks dependencies,
 *                so a pod with a broken database is pulled from the load
 *                balancer instead of serving errors.
 *
 * Both return bare JSON rather than the standard envelope, because probes are
 * consumed by infrastructure, not by our clients.
 */
/**
 * VERSION_NEUTRAL is required. URI versioning is global, so without it these
 * would be served at /v1/health — and every orchestrator, load balancer and
 * uptime probe expects the unversioned path. Probes must also never be rate
 * limited, or a burst of health checks takes the instance out of rotation.
 */
@ApiTags('health')
@SkipThrottle()
@Controller({ path: '', version: VERSION_NEUTRAL })
export class HealthController {
  private static readonly CHECK_TIMEOUT_MS = 2000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness probe' })
  health() {
    return raw({ status: 'ok', uptime: Math.floor(process.uptime()) });
  }

  /**
   * Operational metrics.
   *
   * NOT public. A metrics endpoint exposes request volumes, error rates and
   * worker health — enough for an outsider to profile the system's load and
   * spot when it is struggling, which is exactly when an attacker is most
   * interested. Authenticated, and version-neutral like the probes because
   * scrapers do not speak API versions.
   *
   * Bare JSON rather than the envelope: this is consumed by infrastructure.
   */
  @Get('metrics')
  @ApiOperation({ summary: 'Operational metrics — requests, worker, notifications' })
  metricsSnapshot() {
    return raw(this.metrics.snapshot());
  }

  @Public()
  @Get('readiness')
  @ApiOperation({ summary: 'Readiness probe — checks database and cache' })
  async readiness(@Res({ passthrough: true }) response: Response) {
    // Each check is independently bounded. A Redis socket stuck mid-reconnect
    // will not resolve or reject on its own, so without this the probe hangs
    // rather than reporting the outage it exists to report.
    const [database, cache] = await Promise.all([
      withTimeout(this.prisma.ping(), HealthController.CHECK_TIMEOUT_MS, false),
      withTimeout(this.redis.ping(), HealthController.CHECK_TIMEOUT_MS, false),
    ]);

    const ready = database && cache;

    // The status code is set directly rather than by throwing: an exception
    // would be reshaped into the standard error envelope, discarding the
    // per-dependency detail that tells an operator WHICH dependency is down.
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return raw({ status: ready ? 'ready' : 'unavailable', checks: { database, cache } });
  }
}
