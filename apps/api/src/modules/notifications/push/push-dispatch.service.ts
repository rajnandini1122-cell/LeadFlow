import { Inject, Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../../../common/observability/metrics.service';
import { DevicesRepository } from './devices.repository';
import { PUSH_PROVIDER, type PushMessage, type PushProvider } from './push-provider';

export interface DispatchResult {
  devices: number;
  delivered: number;
  transient: number;
  deactivated: number;
}

/**
 * Turning a persisted notification into pushes on a person's devices.
 *
 * Sits strictly BELOW the notification domain and strictly ABOVE the provider.
 * The Notification row is the source of truth and already exists by the time
 * anything here runs — a push that fails is a notification the user still sees
 * in the bell, which is the right way round and is why delivery is never
 * allowed to roll back creation.
 *
 * Runs OUTSIDE any database transaction. A provider call is a network round
 * trip to a third party with a ten-second timeout; holding a transaction open
 * across that would pin a connection per notification and, under a slow
 * provider, exhaust the pool while the database itself was perfectly healthy.
 */
@Injectable()
export class PushDispatchService {
  private readonly logger = new Logger(PushDispatchService.name);

  constructor(
    private readonly devices: DevicesRepository,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Fans a notification out to every active device the recipient has.
   *
   * Already inside tenant context when called — from the worker via
   * `runWithTenant`, or from a request. Nothing here re-establishes it, because
   * a dispatch path that could set its own tenant would be a dispatch path that
   * could set the wrong one.
   */
  async dispatch(input: {
    userId: string;
    notificationId: string;
    type: string;
    title: string;
    body: string;
    entityType: string | null;
    entityId: string | null;
  }): Promise<DispatchResult> {
    const result: DispatchResult = { devices: 0, delivered: 0, transient: 0, deactivated: 0 };

    const devices = await this.devices.activeTokensFor(input.userId);
    result.devices = devices.length;

    if (devices.length === 0) return result;

    // Nothing configured. Reported rather than silently skipped — an
    // unconfigured production deployment must not look healthy.
    if (!this.provider.isConfigured()) {
      this.metrics.increment(PUSH_METRIC.ATTEMPT, devices.length);
      this.metrics.increment(PUSH_METRIC.FAILURE, devices.length);
      return result;
    }

    const messages: PushMessage[] = devices.map((device) => ({
      token: device.token,
      title: input.title,
      body: input.body,
      /*
       * Ids and a type. Nothing else.
       *
       * This payload travels through a third party and lands in an OS
       * notification tray, so everything in it has left our control. The client
       * uses these to open the right screen and then fetches the real data over
       * an authenticated connection — which is why no customer name, value or
       * message content goes in here beyond what the title and body already
       * show the user on their own lock screen.
       */
      data: {
        notificationId: input.notificationId,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    }));

    const started = Date.now();
    this.metrics.increment(PUSH_METRIC.ATTEMPT, messages.length);

    const results = await this.provider.send(messages);

    this.metrics.observePushLatency(Date.now() - started);

    for (const outcome of results) {
      if (outcome.success) {
        result.delivered += 1;
        this.metrics.increment(PUSH_METRIC.SUCCESS);
        continue;
      }

      this.metrics.increment(PUSH_METRIC.FAILURE);

      if (outcome.failure === 'INVALID_TOKEN') {
        /*
         * The token is dead — uninstalled, rotated, or revoked. Deactivate it
         * and stop trying. Retrying a permanently invalid token forever is how
         * a queue grinds and a provider starts rate-limiting the ones that
         * would have worked.
         *
         * The device row is deactivated, never deleted, and the USER is
         * untouched. A dead phone is not a departed person.
         */
        const deactivated = await this.devices.deactivateByToken(
          outcome.token,
          `provider: ${outcome.reason ?? 'token invalid'}`.slice(0, 120),
        );

        result.deactivated += deactivated;
        this.metrics.increment(PUSH_METRIC.INVALID_TOKEN);

        this.logger.warn(
          /*
           * The device id, never the token. A token in a log line is a
           * credential in a log line, and logs outlive incidents.
           */
          { deviceId: devices.find((device) => device.token === outcome.token)?.id },
          'Deactivated a device whose push token the provider rejected',
        );
        continue;
      }

      if (outcome.failure === 'TRANSIENT') {
        // Left active. The queue's own retry will come back to it.
        result.transient += 1;
      }
    }

    return result;
  }
}

/** Push metric names, in one place so a typo cannot create a phantom series. */
export const PUSH_METRIC = {
  ATTEMPT: 'push.attempt',
  SUCCESS: 'push.success',
  FAILURE: 'push.failure',
  INVALID_TOKEN: 'push.invalid_token',
  REGISTRATIONS: 'push.registrations',
  DEREGISTRATIONS: 'push.deregistrations',
} as const;
