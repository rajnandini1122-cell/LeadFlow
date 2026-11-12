import type { AppConfig } from '../../../common/config/config.module';

/**
 * The recipient restriction every send path consults (campaign confirmation,
 * the dispatcher, broadcasts, test emails). Fails closed: without
 * EMAIL_SENDING_UNRESTRICTED=true, an address may receive campaign email only
 * if it is on EMAIL_RECIPIENT_ALLOWLIST and the organization is
 * EMAIL_ALLOWED_ORGANIZATION_ID. Either unset means nobody.
 */
export class SendingAllowlist {
  private readonly unrestricted: boolean;
  private readonly organizationId: string;
  private readonly addresses: ReadonlySet<string>;

  constructor(config: Pick<AppConfig, 'get'>) {
    this.unrestricted = config.get('EMAIL_SENDING_UNRESTRICTED') === true;
    this.organizationId = String(config.get('EMAIL_ALLOWED_ORGANIZATION_ID') ?? '')
      .trim()
      .toLowerCase();
    this.addresses = new Set(
      String(config.get('EMAIL_RECIPIENT_ALLOWLIST') ?? '')
        .split(',')
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.length > 0),
    );
  }

  allows(organizationId: string, email: string): boolean {
    if (this.unrestricted) return true;
    if (!this.organizationId || this.addresses.size === 0) return false;
    return (
      organizationId.toLowerCase() === this.organizationId &&
      this.addresses.has(email.trim().toLowerCase())
    );
  }

  /** Why an address is refused, in words an administrator can act on. */
  refusal(organizationId: string): string {
    if (!this.organizationId || this.addresses.size === 0) {
      return 'Email sending is restricted on this server and no recipients are approved yet.';
    }
    if (organizationId.toLowerCase() !== this.organizationId) {
      return 'Email sending is restricted to another organization on this server.';
    }
    return 'Email sending is restricted on this server to approved internal addresses.';
  }
}
