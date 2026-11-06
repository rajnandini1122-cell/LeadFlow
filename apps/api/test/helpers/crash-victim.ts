/**
 * A real LeadFlow API process that is killed, not stopped.
 *
 * Spawned by platform-analytics-crash.e2e-spec.ts with the suite's
 * environment. Boots the application exactly as the suite does, serves HTTP,
 * and answers commands on stdin so the parent decides when it flushes. The
 * parent then kills it with SIGKILL (TerminateProcess on Windows): no shutdown
 * hook, no final flush -- what a crash, an OOM kill or a lost container does.
 */
import './admin-analytics-env';
import { createInterface } from 'node:readline';
import { createTestContext } from './test-app';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { TenantContextService } from '../../src/common/tenancy/tenant-context.service';
import { ApiMetricsCollector } from '../../src/modules/platform-analytics/api-metrics.collector';

async function main(): Promise<void> {
  const ctx = await createTestContext();
  const collector = ctx.app.get(ApiMetricsCollector);
  await ctx.app.listen(0, '127.0.0.1');
  const address = ctx.app.getHttpServer().address() as { port: number };
  const say = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);
  say({ ready: true, port: address.port, instanceId: collector.instanceId });

  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'flush') {
      await collector.flush();
      say({ flushed: true, error: collector.lastFlushError });
    } else if (line.startsWith('count ')) {
      // Recorded requests for one route and status, as stored (PGlite allows
      // one connection, so the parent cannot read while this process lives).
      const [, route, status] = line.split(' ');
      const prisma = ctx.app.get(PrismaService).client;
      const rows = await ctx.app
        .get(TenantContextService)
        .runAsSystem('crash test', () =>
          prisma.apiMetricHour.findMany({ where: { route: route!, status: Number(status) } }),
        );
      say({ count: rows.reduce((n, r) => n + r.count, 0) });
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
