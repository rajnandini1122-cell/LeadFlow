import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/config.module';

/**
 * Platform-operator contact details and critical operational alerts.
 *
 * This is the ONLY place `PLATFORM_MASTER_PHONE` is read. Scattering the number
 * through the codebase would make it impossible to change per deployment and
 * easy to leak into a tenant-facing response by accident.
 *
 * What this deliberately is NOT:
 *
 *   - It is not an authentication factor. Nothing here checks a caller's phone
 *     number, and no code path grants a role, a permission or tenant access
 *     because a number matched. A phone number is an identifier, not a
 *     credential: SIM swaps and number recycling make it a poor one, and a
 *     "master number" that unlocks any organization would be a single value
 *     whose disclosure compromises every tenant at once.
 *   - It is not exposed on any tenant-facing endpoint.
 *
 * What it is for: reaching a human operator when something has gone wrong at
 * the platform level, and being available to future support and recovery
 * tooling without that tooling having to invent its own configuration.
 */
@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(private readonly config: AppConfig) {}

  /** The operator contact number, or null when none is configured. */
  get masterPhone(): string | null {
    const value = this.config.get('PLATFORM_MASTER_PHONE');
    return value && value.length > 0 ? value : null;
  }

  get isConfigured(): boolean {
    return this.masterPhone !== null;
  }

  /**
   * Records a condition an operator needs to know about.
   *
   * Logged rather than sent: message delivery belongs to a provider this phase
   * deliberately does not add, and an alert that silently fails to send is
   * worse than one that is reliably written down. The structured fields are
   * what a log-based alerting rule would match on.
   *
   * Never throws — an alert failing must not roll back the operation that
   * triggered it.
   */
  criticalAlert(event: string, details: Record<string, unknown>): void {
    try {
      this.logger.error(
        {
          platform_alert: event,
          contact: this.maskedPhone(),
          ...details,
        },
        `Platform alert: ${event}`,
      );
    } catch {
      // Intentionally swallowed. See above.
    }
  }

  /**
   * The contact number with its middle digits hidden.
   *
   * Enough for an operator reading a log to recognise which number is
   * configured, without writing the whole thing into every aggregator that
   * ingests these lines.
   */
  private maskedPhone(): string | null {
    const phone = this.masterPhone;
    if (!phone) return null;
    if (phone.length <= 6) return '***';

    return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 6)}${phone.slice(-3)}`;
  }
}
