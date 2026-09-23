import { IntakeQueue } from './intake-queue';
import type { AppConfig } from '../common/config/config.module';
import type { RedisService } from '../common/redis/redis.service';
import type { IntakeSweepService } from '../modules/integrations/intake-processing/intake-sweep.service';

/**
 * The two gates in front of automatic conversion.
 *
 * Tested here rather than through the application because what matters is what
 * does NOT happen, and "no queue was created" is invisible from the outside —
 * a suite that booted the app and asserted nothing had converted would pass
 * just as happily if the gates were removed and there were simply no enquiries.
 *
 * The connection factory is the witness: if it is never called, no Redis
 * connection was opened, no scheduler was registered and no worker exists.
 */
describe('IntakeQueue', () => {
  const build = (settings: { worker: boolean; autoProcessing: boolean }) => {
    const createQueueConnection = jest.fn();

    const config = {
      get: (key: string) => {
        if (key === 'WORKER_ENABLED') return settings.worker;
        if (key === 'INTAKE_AUTO_PROCESSING_ENABLED') return settings.autoProcessing;
        if (key === 'INTAKE_SWEEP_INTERVAL_SECONDS') return 60;
        return undefined;
      },
    } as unknown as AppConfig;

    const redis = { createQueueConnection } as unknown as RedisService;
    const sweep = { sweep: jest.fn() } as unknown as IntakeSweepService;

    return { queue: new IntakeQueue(config, redis, sweep), createQueueConnection };
  };

  it('does not run the sweeper in an API process', async () => {
    const { queue, createQueueConnection } = build({ worker: true, autoProcessing: true });
    const api = build({ worker: false, autoProcessing: true });

    await api.queue.onApplicationBootstrap();

    // The API and the worker are built from the same image. Without this gate
    // every replica would sweep, and background work would compete with
    // request latency — which is the whole reason for a separate process.
    expect(api.createQueueConnection).not.toHaveBeenCalled();
    expect(queue).toBeDefined();
    expect(createQueueConnection).not.toHaveBeenCalled();
  });

  it('does nothing in a worker with automatic processing switched off', async () => {
    const { queue, createQueueConnection } = build({ worker: true, autoProcessing: false });

    await queue.onApplicationBootstrap();

    /*
     * The default, and the one that matters most. The intake table is durable
     * and may hold a backlog that arrived before this code existed; a deploy
     * that switched itself on would convert all of it at once, assign it to
     * real salespeople and create a follow-up for each.
     */
    expect(createQueueConnection).not.toHaveBeenCalled();
  });

  it('closes cleanly when nothing was ever opened', async () => {
    const { queue } = build({ worker: false, autoProcessing: false });

    await queue.onApplicationBootstrap();

    // Shutdown must not depend on bootstrap having done anything — an API
    // replica tearing down would otherwise throw on a null worker, and a
    // process that fails to exit is a hung test run.
    await expect(queue.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('survives a Redis it cannot reach', async () => {
    const { queue, createQueueConnection } = build({ worker: true, autoProcessing: true });
    createQueueConnection.mockImplementation(() => {
      throw new Error('ECONNREFUSED');
    });

    // Logged, not thrown. The API half of the same image still serves traffic,
    // and nothing is lost: the enquiries are in PostgreSQL, and the next sweep
    // that does start finds them exactly as they were.
    await expect(queue.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(queue.onModuleDestroy()).resolves.toBeUndefined();
  });
});
