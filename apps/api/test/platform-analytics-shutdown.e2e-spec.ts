// Must be first: the config module reads the environment on import.
import './helpers/admin-analytics-env';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { ApiMetricsCollector } from '../src/modules/platform-analytics/api-metrics.collector';

/**
 * A graceful stop (every Railway deploy) must not lose buffered API counts.
 *
 * Nest disconnects the database in onModuleDestroy, BEFORE any
 * onApplicationShutdown hook runs, so a final flush placed there would find
 * the pool closed. This closes a real application, then reads what it left
 * behind through a second one on the same database.
 */
describe('Platform analytics: graceful shutdown', () => {
  let second: TestContext | undefined;
  afterAll(async () => {
    await second?.close();
  });

  it('writes the last minute of counts and marks the process as stopped cleanly', async () => {
    const first = await createTestContext();
    const collector = first.app.get(ApiMetricsCollector);
    const instanceId = collector.instanceId;
    await collector.flush(); // anything from start-up, so only our requests remain
    const route = '/api/v1/leads';
    for (let i = 0; i < 3; i++)
      await first.http().get(route).set('Authorization', `Bearer ${first.orgA.owner.accessToken}`);
    await first.close();

    second = await createTestContext();
    const prisma = second.app.get(PrismaService).client;
    const system = second.app.get(TenantContextService);
    const [instance, hours] = await system.runAsSystem('e2e', () =>
      Promise.all([
        prisma.apiMetricInstance.findUnique({ where: { id: instanceId } }),
        prisma.apiMetricHour.findMany({ where: { route, method: 'GET', status: 200 } }),
      ]),
    );
    expect(instance?.stoppedAt).not.toBeNull();
    expect(instance?.droppedRequests).toBe(0);
    expect(hours.reduce((n, h) => n + h.count, 0)).toBeGreaterThanOrEqual(3);
  });
});
