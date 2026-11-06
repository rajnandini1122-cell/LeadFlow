// Must be first: the config module reads the environment on import.
import './helpers/admin-analytics-env';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createTestContext, type TestContext } from './helpers/test-app';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TenantContextService } from '../src/common/tenancy/tenant-context.service';
import { AdminAnalyticsService } from '../src/modules/platform-analytics/admin-analytics.service';

/**
 * Abrupt termination: a real API process is KILLED (SIGKILL; TerminateProcess
 * on Windows), so no shutdown hook and no final flush runs.
 *
 * What must hold afterwards:
 *   1. counts written before the kill are intact and exact;
 *   2. counts still in memory are gone -- and nothing pretends otherwise:
 *   3. once the process has missed its heartbeats, every API figure covering
 *      the window says it is a lower bound, naming when the process stopped.
 */
// Real PostgreSQL only (CI runs e2e on postgres:17). PGlite, the fallback for
// machines without Docker, serves a single connection and never releases the
// slot of a client that was killed, so nothing could connect afterwards.
const onRealPostgres = process.env['CI_USE_EXTERNAL_DB'] === '1' ? describe : describe.skip;

onRealPostgres('Platform analytics: abrupt process termination', () => {
  let ctx: TestContext | undefined;
  let victim: ChildProcessWithoutNullStreams | undefined;
  afterAll(async () => {
    victim?.kill('SIGKILL');
    await ctx?.close();
  });

  it('keeps what was flushed, loses at most the buffered minute, and reports it', async () => {
    victim = spawn(
      process.execPath,
      ['-r', join(__dirname, 'helpers', 'ts-register.cjs'), join(__dirname, 'helpers', 'crash-victim.ts')],
      { cwd: join(__dirname, '..'), env: process.env },
    );
    const stderr: string[] = [];
    victim.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    const lines = createInterface({ input: victim.stdout })[Symbol.asyncIterator]();
    const next = async (): Promise<Record<string, unknown>> => {
      for (;;) {
        const { value, done } = await lines.next();
        if (done) throw new Error(`victim exited: ${stderr.join('').slice(-2000)}`);
        if (value.startsWith('{')) return JSON.parse(value) as Record<string, unknown>;
      }
    };
    const send = (command: string) => victim!.stdin.write(`${command}\n`);

    const ready = await next();
    const base = `http://127.0.0.1:${String(ready['port'])}`;
    const instanceId = String(ready['instanceId']);
    const route = '/api/v1/leads';
    const get = () => fetch(`${base}${route}`).then((r) => expect(r.status).toBe(401));

    send(`count ${route} 401`);
    const before = Number((await next())['count']);

    for (let i = 0; i < 3; i++) await get();
    send('flush');
    expect(await next()).toMatchObject({ flushed: true, error: null });
    for (let i = 0; i < 5; i++) await get(); // buffered, never written

    const exited = new Promise((resolve) => victim!.once('exit', resolve));
    victim.kill('SIGKILL');
    await exited;

    ctx = await createTestContext();
    const prisma = ctx.app.get(PrismaService).client;
    const system = ctx.app.get(TenantContextService);
    const [rows, instance] = await system.runAsSystem('e2e', () =>
      Promise.all([
        prisma.apiMetricHour.findMany({ where: { route, status: 401 } }),
        prisma.apiMetricInstance.findUnique({ where: { id: instanceId } }),
      ]),
    );
    try {
      // 1 + 2: exactly the flushed three survived; the five buffered did not.
      expect(rows.reduce((n, r) => n + r.count, 0)).toBe(before + 3);
      expect(instance).toMatchObject({ stoppedAt: null, droppedRequests: 0 });

      // 3: while it could still be alive (under three missed flushes) it is
      // not yet called a crash; after that, every API figure is marked.
      const service = ctx.app.get(AdminAnalyticsService);
      const soon = await service.api({ range: '24h' }, new Date(Date.now() + 60_000));
      expect(soon.totals.completeness.uncleanStops).toHaveLength(0);
      const later = new Date(Date.now() + 4 * 60_000);
      const api = await service.api({ range: '24h' }, later);
      expect(api.totals.completeness.exact).toBe(false);
      expect(api.totals.completeness.uncleanStops).toEqual([
        { lastFlushAt: instance!.lastFlushAt.toISOString(), maxUncountedSeconds: 60 },
      ]);
      const health = await service.health(later);
      expect(health.lastHour.completeness.exact).toBe(false);
    } finally {
      await system.runAsSystem('e2e', () =>
        prisma.apiMetricInstance.deleteMany({ where: { id: instanceId } }),
      );
    }
  });
});
